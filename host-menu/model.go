package main

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	modelVersion = iota
	modelStatus
	modelOperational
	modelRefreshing
	modelFiveHourPresent
	modelFiveHourValue
	modelFiveHourAccountCount
	modelWeeklyPresent
	modelWeeklyValue
	modelWeeklyAccountCount
	modelEarningsAvailable
	modelEarningsCurrency
	modelEarningsToday
	modelEarningsWeek
	modelEarningsMonth
	modelUpdateStatus
	modelUpdateAvailableVersion
	modelUpdateDownloaded
	modelUpdateInstallRequested
	modelUpdateBusy
	modelFirstAccount
)

type quotaWindow struct {
	RemainingPercent float64  `json:"remainingPercent"`
	ResetAt          *float64 `json:"resetAt"`
}

type menuAccount struct {
	DisplayName string       `json:"displayName"`
	Enabled     bool         `json:"enabled"`
	Status      string       `json:"status"`
	UsageStatus string       `json:"usageStatus"`
	FetchedAt   *float64     `json:"fetchedAt"`
	FiveHour    *quotaWindow `json:"fiveHour"`
	Weekly      *quotaWindow `json:"weekly"`
	Monthly     *quotaWindow `json:"monthly"`
}

type menuQuota struct {
	FiveHourRemainingPercent *float64 `json:"fiveHourRemainingPercent"`
	FiveHourAccountCount     int      `json:"fiveHourAccountCount"`
	WeeklyRemainingPercent   *float64 `json:"weeklyRemainingPercent"`
	WeeklyAccountCount       int      `json:"weeklyAccountCount"`
}

type menuEarnings struct {
	Available bool     `json:"available"`
	Currency  *string  `json:"currency"`
	Today     *float64 `json:"today"`
	Week      *float64 `json:"week"`
	Month     *float64 `json:"month"`
}

type menuSummary struct {
	Operational bool          `json:"operational"`
	Accounts    []menuAccount `json:"accounts"`
	Quota       menuQuota     `json:"quota"`
	Earnings    menuEarnings  `json:"earnings"`
}

type updateStatus struct {
	Status           string  `json:"status"`
	AvailableVersion *string `json:"available_version"`
	Downloaded       bool    `json:"downloaded"`
	InstallRequested bool    `json:"install_requested"`
}

type desktopSession struct {
	Path string `json:"path"`
}

type hostCredentials struct {
	AdminToken string `json:"admin_token"`
}

type menuState struct {
	version     string
	status      string
	operational bool
	refreshing  bool
	summary     *menuSummary
	update      *updateStatus
	updateBusy  bool
}

func serializeMenuModel(state menuState) string {
	lines := make([]string, modelFirstAccount)
	lines[modelVersion] = sanitize(state.version)
	lines[modelStatus] = sanitize(state.status)
	lines[modelOperational] = boolString(state.operational)
	lines[modelRefreshing] = boolString(state.refreshing)
	lines[modelFiveHourPresent] = "0"
	lines[modelWeeklyPresent] = "0"
	lines[modelEarningsAvailable] = "0"
	lines[modelEarningsToday] = "Not available"
	lines[modelEarningsWeek] = "Not available"
	lines[modelEarningsMonth] = "Not available"
	lines[modelUpdateDownloaded] = "0"
	lines[modelUpdateInstallRequested] = "0"
	lines[modelUpdateBusy] = boolString(state.updateBusy)

	if state.summary != nil {
		quota := state.summary.Quota
		setNumberFields(lines, modelFiveHourPresent, quota.FiveHourRemainingPercent)
		lines[modelFiveHourAccountCount] = accountCountText(quota.FiveHourAccountCount)
		setNumberFields(lines, modelWeeklyPresent, quota.WeeklyRemainingPercent)
		lines[modelWeeklyAccountCount] = accountCountText(quota.WeeklyAccountCount)

		earnings := state.summary.Earnings
		if earnings.Available && earnings.Currency != nil && strings.TrimSpace(*earnings.Currency) != "" {
			lines[modelEarningsAvailable] = "1"
			lines[modelEarningsCurrency] = sanitize(*earnings.Currency)
			lines[modelEarningsToday] = earningValue(earnings.Today, earnings.Currency)
			lines[modelEarningsWeek] = earningValue(earnings.Week, earnings.Currency)
			lines[modelEarningsMonth] = earningValue(earnings.Month, earnings.Currency)
		}
		for _, account := range state.summary.Accounts {
			lines = append(lines, serializeAccount(account))
		}
	}
	if state.update != nil {
		lines[modelUpdateStatus] = sanitize(state.update.Status)
		if state.update.AvailableVersion != nil {
			lines[modelUpdateAvailableVersion] = sanitize(*state.update.AvailableVersion)
		}
		lines[modelUpdateDownloaded] = boolString(state.update.Downloaded)
		lines[modelUpdateInstallRequested] = boolString(state.update.InstallRequested)
	}
	return strings.Join(lines, "\n")
}

func serializeAccount(account menuAccount) string {
	fields := []string{"A", account.DisplayName, account.Status, account.UsageStatus}
	for _, window := range []*quotaWindow{account.FiveHour, account.Weekly, account.Monthly} {
		if window == nil || account.UsageStatus == "unsupported" || !hasResetTime(window.ResetAt) {
			fields = append(fields, "0", "", "No reset time")
			continue
		}
		fields = append(fields, "1", formatPercent(window.RemainingPercent), resetText(window.ResetAt))
	}
	fields = append(fields, usageText(account))
	for index := range fields {
		fields[index] = sanitize(fields[index])
	}
	return strings.Join(fields, "\t")
}

func setNumberFields(lines []string, presentIndex int, value *float64) {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return
	}
	lines[presentIndex] = "1"
	lines[presentIndex+1] = formatPercent(*value)
}

func formatPercent(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "—"
	}
	value = math.Max(0, math.Min(100, value))
	return strconv.Itoa(int(math.Round(value))) + "%"
}

func earningValue(value *float64, currency *string) string {
	if value == nil || currency == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return "Not available"
	}
	symbol := map[string]string{"EUR": "€", "USD": "$", "GBP": "£"}[strings.ToUpper(*currency)]
	if symbol != "" {
		return fmt.Sprintf("%s%.2f", symbol, *value)
	}
	return fmt.Sprintf("%.2f %s", *value, sanitize(*currency))
}

func resetText(timestamp *float64) string {
	if !hasResetTime(timestamp) {
		return "No reset time"
	}
	return "Resets " + relativeTime(time.UnixMilli(int64(*timestamp)))
}

func hasResetTime(timestamp *float64) bool {
	return timestamp != nil && !math.IsNaN(*timestamp) && !math.IsInf(*timestamp, 0)
}

func usageText(account menuAccount) string {
	if account.UsageStatus == "unsupported" {
		return "OpenAI does not expose quota usage for this account."
	}
	if account.FetchedAt == nil || math.IsNaN(*account.FetchedAt) || math.IsInf(*account.FetchedAt, 0) {
		return "Waiting for the first quota refresh."
	}
	return "Updated " + relativeTime(time.UnixMilli(int64(*account.FetchedAt)))
}

func relativeTime(timestamp time.Time) string {
	delta := timestamp.Sub(time.Now())
	future := delta > 0
	if delta < 0 {
		delta = -delta
	}
	value := int64(delta / time.Second)
	unit := "sec."
	if value >= 60 {
		value = int64(delta / time.Minute)
		unit = "min."
	}
	if value >= 60 {
		value = int64(delta / time.Hour)
		unit = "hour"
	}
	if value >= 24 && unit == "hour" {
		value = int64(delta / (24 * time.Hour))
		unit = "day"
	}
	if value != 1 {
		unit += "s"
	}
	if future {
		return fmt.Sprintf("in %d %s", value, unit)
	}
	return fmt.Sprintf("%d %s ago", value, unit)
}

func boolString(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func accountCountText(count int) string {
	if count == 1 {
		return "1 account"
	}
	return strconv.Itoa(count) + " accounts"
}

func sanitize(value string) string {
	return strings.NewReplacer("\t", " ", "\n", " ", "\r", " ").Replace(value)
}

var enrollmentTokenPattern = regexp.MustCompile(`^mve_[A-Za-z0-9_-]{43}$`)

func parseEnrollmentLink(raw string) (string, bool) {
	if len(raw) > 256 {
		return "", true
	}
	parsed, err := url.Parse(raw)
	if err != nil || strings.ToLower(parsed.Scheme) != "multivibe" || strings.ToLower(parsed.Host) != "add-worker" ||
		parsed.Path != "" || parsed.Port() != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment == "" {
		return "", true
	}
	items, err := url.ParseQuery(parsed.Fragment)
	if err != nil || len(items) != 1 || len(items["enrollment_token"]) != 1 || !enrollmentTokenPattern.MatchString(items.Get("enrollment_token")) {
		return "", true
	}
	return items.Get("enrollment_token"), false
}
