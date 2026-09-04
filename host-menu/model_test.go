package main

import (
	"strings"
	"testing"
	"time"
)

func floatPointer(value float64) *float64 {
	return &value
}

func stringPointer(value string) *string {
	return &value
}

func TestSerializeMenuModelUsesNativePopupCopy(t *testing.T) {
	model := serializeMenuModel(menuState{
		version:     "0.2.10",
		status:      "Operational",
		operational: true,
		summary: &menuSummary{
			Quota: menuQuota{
				FiveHourRemainingPercent: floatPointer(82.4),
				FiveHourAccountCount:     2,
				WeeklyRemainingPercent:   floatPointer(61.2),
				WeeklyAccountCount:       1,
			},
			Earnings: menuEarnings{
				Available: true,
				Currency:  stringPointer("EUR"),
				Today:     floatPointer(1.25),
				Week:      floatPointer(7),
				Month:     floatPointer(31.5),
			},
			Accounts: []menuAccount{{
				DisplayName: "person@example.com",
				Status:      "ready",
				UsageStatus: "available",
				FetchedAt:   floatPointer(float64(time.Now().UnixMilli())),
				FiveHour:    &quotaWindow{RemainingPercent: 82.4},
			}},
		},
		update: &updateStatus{Status: "current"},
	})

	lines := strings.Split(model, "\n")
	if got, want := lines[5], "82%"; got != want {
		t.Fatalf("five-hour percentage = %q, want %q", got, want)
	}
	if got, want := lines[6], "2 accounts"; got != want {
		t.Fatalf("five-hour account count = %q, want %q", got, want)
	}
	if got, want := lines[9], "1 account"; got != want {
		t.Fatalf("weekly account count = %q, want %q", got, want)
	}
	if got, want := lines[12], "€1.25"; got != want {
		t.Fatalf("today earnings = %q, want %q", got, want)
	}
	if got, want := lines[15], "current"; got != want {
		t.Fatalf("update status = %q, want %q", got, want)
	}
	if got := lines[20]; !strings.HasPrefix(got, "A\tperson@example.com\tready\tavailable\t1\t82%\tNo reset time\t0\t\tNo reset time\t0\t\tNo reset time\tUpdated ") {
		t.Fatalf("account model = %q", got)
	}
}

func TestParseEnrollmentLink(t *testing.T) {
	token := "mve_" + strings.Repeat("a", 43)
	if got, invalid := parseEnrollmentLink("multivibe://add-worker#enrollment_token=" + token); invalid || got != token {
		t.Fatalf("valid enrollment link parsed as %q, invalid=%t", got, invalid)
	}
	if _, invalid := parseEnrollmentLink("multivibe://other#enrollment_token=" + token); !invalid {
		t.Fatal("invalid enrollment link was accepted")
	}
}
