//go:build linux && cgo

#include "menu.h"

#include <gtk/gtk.h>
#include <stdlib.h>
#include <string.h>

extern void goMenuAction(int action);
extern void goEnrollmentDecision(int accepted);

static GtkWidget *window;
static GtkWidget *header_title;
static GtkWidget *header_status;
static GtkWidget *content_box;
static GtkWidget *primary_button;
static GtkWidget *refresh_button;
static GtkStatusIcon *status_icon;
static GtkWidget *start_at_login;

static const char *menu_css =
    "window { background-color: #f2f3f4; }"
    "label { color: #292d32; }"
    ".header { padding: 18px; }"
    ".header-title { font-size: 20px; font-weight: 700; }"
    ".header-status { font-size: 14px; }"
    ".header-status.operational { color: #18a83a; }"
    ".section { font-size: 15px; font-weight: 700; margin-top: 2px; }"
    ".card { background-color: rgba(255,255,255,0.88); border: 1px solid #8f959b; border-radius: 14px; }"
    ".card-content { padding: 14px; }"
    ".quota-title { color: #65696e; font-size: 14px; font-weight: 600; }"
    ".quota-value { color: #3d4145; font-size: 30px; font-weight: 700; }"
    ".quota-detail { color: #969a9e; font-size: 13px; }"
    ".compact-title { color: #65696e; font-size: 13px; font-weight: 700; }"
    ".compact-value { color: #3d4145; font-size: 24px; font-weight: 700; }"
    ".compact-reset { color: #969a9e; font-size: 12px; }"
    ".account-name { color: #464a4f; font-size: 18px; font-weight: 700; }"
    ".badge { border-radius: 12px; padding: 3px 9px; font-size: 12px; font-weight: 700; }"
    ".badge-ready { color: #0da936; background-color: #d7efdd; }"
    ".badge-paused { color: #6d7378; background-color: #e4e6e8; }"
    ".badge-limited { color: #c36a00; background-color: #ffebcc; }"
    ".badge-attention { color: #d22e2e; background-color: #ffdede; }"
    ".updated { color: #858a8f; font-size: 12px; }"
    ".muted { color: #747a80; font-size: 13px; }"
    ".update-title { font-size: 16px; font-weight: 700; }"
    ".update-detail { color: #656b70; font-size: 13px; }"
    ".footer { padding: 12px 18px 16px; }"
    ".progressbar trough { min-height: 7px; border: 0; border-radius: 4px; background-color: #eceeef; }"
    ".progressbar progress { min-height: 7px; border-radius: 4px; background-color: #1478e8; }"
    ".quota-warning progress { background-color: #ff9500; }"
    ".quota-danger progress { background-color: #f04444; }";

static void add_class(GtkWidget *widget, const char *class_name) {
    GtkStyleContext *context = gtk_widget_get_style_context(widget);
    gtk_style_context_add_class(context, class_name);
}

static void set_margins(GtkWidget *widget, int top, int right, int bottom, int left) {
    gtk_widget_set_margin_top(widget, top);
    gtk_widget_set_margin_end(widget, right);
    gtk_widget_set_margin_bottom(widget, bottom);
    gtk_widget_set_margin_start(widget, left);
}

static GtkWidget *text_label(const char *text, const char *class_name) {
    GtkWidget *label = gtk_label_new(text ? text : "");
    gtk_label_set_xalign(GTK_LABEL(label), 0.0f);
    gtk_label_set_line_wrap(GTK_LABEL(label), TRUE);
    gtk_label_set_line_wrap_mode(GTK_LABEL(label), PANGO_WRAP_WORD_CHAR);
    if (class_name) add_class(label, class_name);
    return label;
}

static void set_label(GtkWidget *label, const char *text) {
    gtk_label_set_text(GTK_LABEL(label), text ? text : "");
}

static const char *line_at(gchar **lines, gsize count, int index) {
    if (index < 0 || (gsize)index >= count || !lines[index]) return "";
    return lines[index];
}

static GtkWidget *card(void) {
    GtkWidget *frame = gtk_frame_new(NULL);
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    add_class(frame, "card");
    add_class(box, "card-content");
    gtk_frame_set_shadow_type(GTK_FRAME(frame), GTK_SHADOW_NONE);
    gtk_container_add(GTK_CONTAINER(frame), box);
    return frame;
}

static GtkWidget *card_content(GtkWidget *frame) {
    GList *children = gtk_container_get_children(GTK_CONTAINER(frame));
    GtkWidget *content = children ? GTK_WIDGET(children->data) : NULL;
    g_list_free(children);
    return content;
}

static GtkWidget *section_label(const char *title) {
    GtkWidget *label = text_label(title, "section");
    set_margins(label, 2, 0, 0, 0);
    return label;
}

static GtkWidget *quota_progress(int present, double remaining) {
    GtkWidget *progress = gtk_progress_bar_new();
    gtk_progress_bar_set_show_text(GTK_PROGRESS_BAR(progress), FALSE);
    gtk_widget_set_size_request(progress, -1, 7);
    gtk_widget_set_hexpand(progress, TRUE);
    if (present) {
        double safe_value = remaining < 0.0 ? 0.0 : remaining > 100.0 ? 100.0 : remaining;
        gtk_progress_bar_set_fraction(GTK_PROGRESS_BAR(progress), safe_value / 100.0);
        if (safe_value <= 10.0) add_class(progress, "quota-danger");
        else if (safe_value <= 30.0) add_class(progress, "quota-warning");
    } else {
        gtk_progress_bar_set_fraction(GTK_PROGRESS_BAR(progress), 0.0);
    }
    return progress;
}

static GtkWidget *quota_cell(const char *title, const char *value, int present, double remaining, const char *detail) {
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 5);
    GtkWidget *title_label = text_label(title, "quota-title");
    GtkWidget *value_label = text_label(value, "quota-value");
    GtkWidget *progress = quota_progress(present, remaining);
    GtkWidget *detail_label = text_label(detail, "quota-detail");
    gtk_box_pack_start(GTK_BOX(box), title_label, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), value_label, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), progress, FALSE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(box), detail_label, FALSE, FALSE, 0);
    return box;
}

static GtkWidget *summary_card(const char *five_present, const char *five_value, const char *five_count,
                               const char *weekly_present, const char *weekly_value, const char *weekly_count) {
    GtkWidget *frame = card();
    GtkWidget *grid = gtk_grid_new();
    GtkWidget *five = quota_cell("5 hours", five_present[0] == '1' ? five_value : "—",
                                 five_present[0] == '1', g_ascii_strtod(five_value, NULL), five_count);
    GtkWidget *weekly = quota_cell("Weekly", weekly_present[0] == '1' ? weekly_value : "—",
                                    weekly_present[0] == '1', g_ascii_strtod(weekly_value, NULL), weekly_count);
    gtk_grid_set_column_spacing(GTK_GRID(grid), 18);
    gtk_grid_set_column_homogeneous(GTK_GRID(grid), TRUE);
    gtk_widget_set_hexpand(grid, TRUE);
    gtk_grid_attach(GTK_GRID(grid), five, 0, 0, 1, 1);
    gtk_grid_attach(GTK_GRID(grid), weekly, 1, 0, 1, 1);
    gtk_box_pack_start(GTK_BOX(card_content(frame)), grid, TRUE, TRUE, 0);
    return frame;
}

static GtkWidget *compact_quota(const char *title, const char *value, const char *reset) {
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    GtkWidget *title_label = text_label(title, "compact-title");
    GtkWidget *value_label = text_label(value, "compact-value");
    GtkWidget *progress = quota_progress(1, g_ascii_strtod(value, NULL));
    GtkWidget *reset_label = text_label(reset, "compact-reset");
    gtk_box_pack_start(GTK_BOX(box), title_label, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), value_label, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), progress, FALSE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(box), reset_label, FALSE, FALSE, 0);
    return box;
}

static int quota_window_displayable(const char *present, const char *reset, int unsupported) {
    return !unsupported && present[0] == '1' && reset[0] != '\0' && g_strcmp0(reset, "No reset time") != 0;
}

static const char *status_copy(const char *status) {
    if (g_strcmp0(status, "ready") == 0) return "Ready";
    if (g_strcmp0(status, "paused") == 0) return "Paused";
    if (g_strcmp0(status, "limited") == 0) return "Limited";
    return "Attention";
}

static const char *status_class(const char *status) {
    if (g_strcmp0(status, "ready") == 0) return "badge-ready";
    if (g_strcmp0(status, "paused") == 0) return "badge-paused";
    if (g_strcmp0(status, "limited") == 0) return "badge-limited";
    return "badge-attention";
}

static GtkWidget *account_card(gchar **fields) {
    GtkWidget *frame = card();
    GtkWidget *box = card_content(frame);
    GtkWidget *header = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *name = text_label(fields[1], "account-name");
    GtkWidget *spacer = gtk_label_new("");
    GtkWidget *badge = text_label(status_copy(fields[2]), "badge");
    GtkWidget *grid = gtk_grid_new();
    int unsupported = g_strcmp0(fields[3], "unsupported") == 0;
    const char *titles[] = {"5H", "WEEK", "MONTH"};
    const char *presents[] = {fields[4], fields[7], fields[10]};
    const char *values[] = {fields[5], fields[8], fields[11]};
    const char *resets[] = {fields[6], fields[9], fields[12]};
    int column = 0;

    add_class(badge, status_class(fields[2]));
    gtk_widget_set_hexpand(name, TRUE);
    gtk_widget_set_hexpand(spacer, TRUE);
    gtk_box_pack_start(GTK_BOX(header), name, TRUE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(header), spacer, TRUE, TRUE, 0);
    gtk_box_pack_end(GTK_BOX(header), badge, FALSE, FALSE, 0);

    gtk_grid_set_column_spacing(GTK_GRID(grid), 12);
    gtk_grid_set_column_homogeneous(GTK_GRID(grid), TRUE);
    gtk_widget_set_hexpand(grid, TRUE);
    for (int index = 0; index < 3; index++) {
        if (!quota_window_displayable(presents[index], resets[index], unsupported)) continue;
        gtk_grid_attach(GTK_GRID(grid), compact_quota(titles[index], values[index], resets[index]), column, 0, 1, 1);
        column++;
    }

    gtk_box_pack_start(GTK_BOX(box), header, FALSE, FALSE, 0);
    if (column > 0) gtk_box_pack_start(GTK_BOX(box), grid, FALSE, TRUE, 11);
    gtk_box_pack_start(GTK_BOX(box), text_label(fields[13], "updated"), FALSE, FALSE, 0);
    return frame;
}

static GtkWidget *empty_accounts_card(int operational) {
    GtkWidget *frame = card();
    GtkWidget *box = card_content(frame);
    gtk_box_pack_start(GTK_BOX(box), text_label(operational ? "No OpenAI account yet" : "Host data unavailable", "update-title"), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), text_label(
        operational ? "Add an account from the dashboard to see its quota here." : "Start or refresh MultiVibe Host to load your accounts.",
        "muted"), FALSE, FALSE, 5);
    return frame;
}

static GtkWidget *earning_row(const char *title, const char *value) {
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *title_label = text_label(title, "muted");
    GtkWidget *spacer = gtk_label_new("");
    GtkWidget *value_label = text_label(value, "quota-title");
    gtk_widget_set_hexpand(spacer, TRUE);
    gtk_box_pack_start(GTK_BOX(row), title_label, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(row), spacer, TRUE, TRUE, 0);
    gtk_box_pack_end(GTK_BOX(row), value_label, FALSE, FALSE, 0);
    return row;
}

static GtkWidget *earnings_card(const char *today, const char *week, const char *month) {
    GtkWidget *frame = card();
    GtkWidget *box = card_content(frame);
    gtk_box_pack_start(GTK_BOX(box), earning_row("Today", today), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), earning_row("This week", week), FALSE, FALSE, 8);
    gtk_box_pack_start(GTK_BOX(box), earning_row("This month", month), FALSE, FALSE, 8);
    return frame;
}

static void on_check_updates(GtkButton *button, gpointer data) {
    (void)button;
    (void)data;
    goMenuAction(MULTIVIBE_MENU_ACTION_CHECK_UPDATES);
}

static void on_install_update(GtkButton *button, gpointer data) {
    (void)button;
    (void)data;
    goMenuAction(MULTIVIBE_MENU_ACTION_INSTALL_UPDATE);
}

static GtkWidget *update_card(const char *status, const char *available_version,
                              int downloaded, int install_requested, int busy) {
    GtkWidget *frame = card();
    GtkWidget *box = card_content(frame);
    GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *check = gtk_button_new_with_label(busy ? "Checking..." : "Check Now");
    const char *title;
    const char *detail;

    if (available_version[0]) {
        title = g_strdup_printf("Version %s available", available_version);
        detail = downloaded ? "Verified download ready to install." : "Ready for verified background download.";
    } else if (g_strcmp0(status, "current") == 0) {
        title = "MultiVibe Host is up to date";
        detail = "The signed stable release feed is checked periodically.";
    } else {
        title = "Automatic verified updates";
        detail = "Check the signed release feed now or manage policy in the dashboard.";
    }

    gtk_widget_set_sensitive(check, !busy);
    g_signal_connect(check, "clicked", G_CALLBACK(on_check_updates), NULL);
    gtk_box_pack_start(GTK_BOX(box), text_label(title, "update-title"), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), text_label(detail, "update-detail"), FALSE, FALSE, 9);
    gtk_box_pack_start(GTK_BOX(box), actions, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(actions), check, FALSE, FALSE, 0);
    if (available_version[0]) {
        GtkWidget *install = gtk_button_new_with_label(install_requested ? "Installation Queued" : "Install Safely");
        gtk_widget_set_sensitive(install, !busy && !install_requested);
        g_signal_connect(install, "clicked", G_CALLBACK(on_install_update), NULL);
        gtk_box_pack_start(GTK_BOX(actions), install, FALSE, FALSE, 0);
    }
    if (available_version[0]) g_free((gpointer)title);
    return frame;
}

static void remove_content_children(void) {
    GList *children = gtk_container_get_children(GTK_CONTAINER(content_box));
    for (GList *item = children; item; item = item->next) gtk_widget_destroy(GTK_WIDGET(item->data));
    g_list_free(children);
}

static int field_bool(gchar **lines, gsize count, int index) {
    const char *value = line_at(lines, count, index);
    return value[0] == '1';
}

static void apply_model(const char *model) {
    gchar **lines = g_strsplit(model ? model : "", "\n", -1);
    gsize line_count = g_strv_length(lines);
    int account_count = 0;
    gboolean was_visible = gtk_widget_get_visible(window);
    char *title;

    title = g_strdup_printf("MultiVibe Host  %s", line_at(lines, line_count, 0)[0] ? line_at(lines, line_count, 0) : "unknown");
    set_label(header_title, title);
    g_free(title);
    set_label(header_status, line_at(lines, line_count, 1)[0] ? line_at(lines, line_count, 1) : "Unavailable");
    {
        GtkStyleContext *context = gtk_widget_get_style_context(header_status);
        gtk_style_context_remove_class(context, "operational");
        if (field_bool(lines, line_count, 2)) gtk_style_context_add_class(context, "operational");
    }
    gtk_button_set_label(GTK_BUTTON(primary_button), field_bool(lines, line_count, 2) ? "Open Dashboard" : "Start Host");
    gtk_button_set_label(GTK_BUTTON(refresh_button), field_bool(lines, line_count, 3) ? "Refreshing..." : "Refresh");
    gtk_widget_set_sensitive(refresh_button, !field_bool(lines, line_count, 3));

    remove_content_children();
    gtk_box_pack_start(GTK_BOX(content_box), section_label("OPENAI CAPACITY"), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(content_box), summary_card(
        line_at(lines, line_count, 4), line_at(lines, line_count, 5), line_at(lines, line_count, 6),
        line_at(lines, line_count, 7), line_at(lines, line_count, 8), line_at(lines, line_count, 9)), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(content_box), section_label("ACCOUNTS"), FALSE, FALSE, 0);

    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(start_at_login), field_bool(lines, line_count, 20));
    for (gsize index = 21; index < line_count; index++) {
        if (lines[index][0] != 'A' || lines[index][1] != '\t') continue;
        gchar **fields = g_strsplit(lines[index], "\t", -1);
        if (g_strv_length(fields) >= 14) {
            gtk_box_pack_start(GTK_BOX(content_box), account_card(fields), FALSE, TRUE, 0);
            account_count++;
        }
        g_strfreev(fields);
    }
    if (account_count == 0) {
        gtk_box_pack_start(GTK_BOX(content_box), empty_accounts_card(field_bool(lines, line_count, 2)), FALSE, FALSE, 0);
    }
    gtk_box_pack_start(GTK_BOX(content_box), section_label("EARNINGS"), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(content_box), earnings_card(field_bool(lines, line_count, 10) ? line_at(lines, line_count, 12) : "Not available",
                                                            field_bool(lines, line_count, 10) ? line_at(lines, line_count, 13) : "Not available",
                                                            field_bool(lines, line_count, 10) ? line_at(lines, line_count, 14) : "Not available"), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(content_box), section_label("HOST UPDATES"), FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(content_box), update_card(line_at(lines, line_count, 15), line_at(lines, line_count, 16),
                                                          field_bool(lines, line_count, 17), field_bool(lines, line_count, 18),
                                                          field_bool(lines, line_count, 19)), FALSE, FALSE, 0);
    gtk_widget_show_all(window);
    if (!was_visible) gtk_widget_hide(window);
    g_strfreev(lines);
}

static gboolean apply_model_idle(gpointer data) {
    char *model = data;
    if (window) apply_model(model);
    g_free(model);
    return G_SOURCE_REMOVE;
}

static gboolean stop_idle(gpointer data) {
    (void)data;
    gtk_main_quit();
    return G_SOURCE_REMOVE;
}

static gboolean on_window_delete(GtkWidget *widget, GdkEvent *event, gpointer data) {
    (void)event;
    (void)data;
    gtk_widget_hide(widget);
    return TRUE;
}

typedef struct {
    char *title;
    char *message;
    int warning;
} message_payload;

static void on_enrollment_response(GtkDialog *dialog, gint response_id, gpointer data) {
    (void)data;
    goEnrollmentDecision(response_id == GTK_RESPONSE_ACCEPT ? 1 : 0);
    gtk_widget_destroy(GTK_WIDGET(dialog));
}

static GtkWidget *message_dialog(const char *title, const char *message, int warning) {
    GtkWidget *dialog = gtk_message_dialog_new(
        window ? GTK_WINDOW(window) : NULL,
        GTK_DIALOG_MODAL | GTK_DIALOG_DESTROY_WITH_PARENT,
        warning ? GTK_MESSAGE_WARNING : GTK_MESSAGE_INFO,
        GTK_BUTTONS_OK,
        "%s",
        title ? title : "MultiVibe Host"
    );
    gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s", message ? message : "");
    return dialog;
}

static gboolean show_message_idle(gpointer data) {
    message_payload *payload = data;
    GtkWidget *dialog = message_dialog(payload->title, payload->message, payload->warning);
    if (dialog) {
        g_signal_connect_swapped(dialog, "response", G_CALLBACK(gtk_widget_destroy), dialog);
        gtk_window_present(GTK_WINDOW(dialog));
    }
    g_free(payload->title);
    g_free(payload->message);
    g_free(payload);
    return G_SOURCE_REMOVE;
}

static gboolean request_enrollment_idle(gpointer data) {
    GtkWidget *dialog;
    (void)data;
    if (!window) return G_SOURCE_REMOVE;
    dialog = gtk_message_dialog_new(
        GTK_WINDOW(window),
        GTK_DIALOG_MODAL | GTK_DIALOG_DESTROY_WITH_PARENT,
        GTK_MESSAGE_QUESTION,
        GTK_BUTTONS_NONE,
        "%s",
        "Add this Linux host to MultiVibe Cloud?"
    );
    gtk_message_dialog_format_secondary_text(
        GTK_MESSAGE_DIALOG(dialog),
        "%s",
        "MultiVibe Host will share its public device identity and selected local models. Your private key stays on this Linux host."
    );
    gtk_dialog_add_button(GTK_DIALOG(dialog), "Add this Linux host", GTK_RESPONSE_ACCEPT);
    gtk_dialog_add_button(GTK_DIALOG(dialog), "Cancel", GTK_RESPONSE_CANCEL);
    g_signal_connect(dialog, "response", G_CALLBACK(on_enrollment_response), NULL);
    gtk_window_present(GTK_WINDOW(dialog));
    return G_SOURCE_REMOVE;
}

static void toggle_window(void) {
    if (gtk_widget_get_visible(window)) gtk_widget_hide(window);
    else {
        gtk_widget_show_all(window);
        gtk_window_present(GTK_WINDOW(window));
    }
}

static void on_status_activate(GtkStatusIcon *icon, gpointer data) {
    (void)icon;
    (void)data;
    toggle_window();
    goMenuAction(MULTIVIBE_MENU_ACTION_TOGGLE);
}

static void on_primary_clicked(GtkButton *button, gpointer data) {
    (void)button;
    (void)data;
    goMenuAction(MULTIVIBE_MENU_ACTION_OPEN_DASHBOARD);
}

static void on_refresh_clicked(GtkButton *button, gpointer data) {
    (void)button;
    (void)data;
    goMenuAction(MULTIVIBE_MENU_ACTION_REFRESH);
}

static void on_quit_clicked(GtkButton *button, gpointer data) {
    (void)button;
    (void)data;
    goMenuAction(MULTIVIBE_MENU_ACTION_QUIT);
}
static void on_start_at_login_toggled(GtkToggleButton *button, gpointer data) { (void)data; goMenuAction(gtk_toggle_button_get_active(button) ? MULTIVIBE_MENU_ACTION_START_AT_LOGIN_ON : MULTIVIBE_MENU_ACTION_START_AT_LOGIN_OFF); }

int multivibe_menu_init(const char *icon_path) {
    int argc = 1;
    char program_name[] = "multivibe-host-menu";
    char *arguments[] = {program_name, NULL};
    GtkCssProvider *css;
    GtkWidget *root;
    GtkWidget *header;
    GtkWidget *header_image;
    GtkWidget *header_labels;
    GtkWidget *separator;
    GtkWidget *scroll;
    GtkWidget *footer;
    GtkWidget *footer_separator;
    GtkWidget *actions;
    char **argv = arguments;

    if (!gtk_init_check(&argc, &argv)) return 0;

    css = gtk_css_provider_new();
    gtk_css_provider_load_from_data(css, menu_css, -1, NULL);
    gtk_style_context_add_provider_for_screen(gdk_screen_get_default(), GTK_STYLE_PROVIDER(css), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
    g_object_unref(css);

    window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "MultiVibe Host");
    gtk_window_set_default_size(GTK_WINDOW(window), 420, 570);
    gtk_window_set_resizable(GTK_WINDOW(window), FALSE);
    gtk_window_set_position(GTK_WINDOW(window), GTK_WIN_POS_CENTER);
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(window), TRUE);
    g_signal_connect(window, "delete-event", G_CALLBACK(on_window_delete), NULL);

    root = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_container_add(GTK_CONTAINER(window), root);

    header = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
    add_class(header, "header");
    header_image = icon_path && icon_path[0] ? gtk_image_new_from_file(icon_path) : gtk_image_new_from_icon_name("applications-system", GTK_ICON_SIZE_DIALOG);
    gtk_image_set_pixel_size(GTK_IMAGE(header_image), 38);
    header_labels = gtk_box_new(GTK_ORIENTATION_VERTICAL, 3);
    header_title = text_label("MultiVibe Host  unknown", "header-title");
    header_status = text_label("Starting...", "header-status");
    gtk_box_pack_start(GTK_BOX(header_labels), header_title, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(header_labels), header_status, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(header), header_image, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(header), header_labels, TRUE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(root), header, FALSE, FALSE, 0);

    separator = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_box_pack_start(GTK_BOX(root), separator, FALSE, FALSE, 0);

    scroll = gtk_scrolled_window_new(NULL, NULL);
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroll), GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
    gtk_widget_set_vexpand(scroll, TRUE);
    content_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    set_margins(content_box, 14, 18, 16, 18);
    gtk_widget_set_hexpand(content_box, TRUE);
    gtk_container_add(GTK_CONTAINER(scroll), content_box);
    gtk_box_pack_start(GTK_BOX(root), scroll, TRUE, TRUE, 0);

    footer_separator = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_box_pack_start(GTK_BOX(root), footer_separator, FALSE, FALSE, 0);
    footer = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    add_class(footer, "footer");
    actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    primary_button = gtk_button_new_with_label("Open Dashboard");
    refresh_button = gtk_button_new_with_label("Refresh");
    GtkWidget *quit_button = gtk_button_new_with_label("Quit");
    gtk_widget_set_hexpand(primary_button, TRUE);
    g_signal_connect(primary_button, "clicked", G_CALLBACK(on_primary_clicked), NULL);
    g_signal_connect(refresh_button, "clicked", G_CALLBACK(on_refresh_clicked), NULL);
    g_signal_connect(quit_button, "clicked", G_CALLBACK(on_quit_clicked), NULL);
    gtk_box_pack_start(GTK_BOX(actions), primary_button, TRUE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(actions), refresh_button, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(actions), quit_button, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(footer), actions, FALSE, FALSE, 0);
    start_at_login = gtk_check_button_new_with_label("Start MultiVibe Host when I log in");
    g_signal_connect(start_at_login, "toggled", G_CALLBACK(on_start_at_login_toggled), NULL);
    gtk_box_pack_start(GTK_BOX(footer), start_at_login, FALSE, FALSE, 8);
    gtk_box_pack_start(GTK_BOX(root), footer, FALSE, FALSE, 0);

    status_icon = gtk_status_icon_new();
    if (icon_path && icon_path[0] && g_file_test(icon_path, G_FILE_TEST_IS_REGULAR)) {
        gtk_status_icon_set_from_file(status_icon, icon_path);
    } else {
        gtk_status_icon_set_from_icon_name(status_icon, "applications-system");
    }
    gtk_status_icon_set_tooltip_text(status_icon, "MultiVibe Host");
    gtk_status_icon_set_visible(status_icon, TRUE);
    g_signal_connect(status_icon, "activate", G_CALLBACK(on_status_activate), NULL);
    return 1;
}

void multivibe_menu_run(void) {
    gtk_main();
}

void multivibe_menu_set_model(const char *model) {
    if (window && model) g_idle_add(apply_model_idle, g_strdup(model));
}

void multivibe_menu_request_enrollment(void) {
    if (!window) return;
    g_idle_add(request_enrollment_idle, NULL);
}

void multivibe_menu_show_message(const char *title, const char *message, int warning) {
    message_payload *payload = g_new0(message_payload, 1);
    payload->title = g_strdup(title ? title : "MultiVibe Host");
    payload->message = g_strdup(message ? message : "");
    payload->warning = warning;
    if (g_idle_add(show_message_idle, payload) == 0) {
        g_free(payload->title);
        g_free(payload->message);
        g_free(payload);
    }
}

void multivibe_menu_stop(void) {
    if (window) g_idle_add(stop_idle, NULL);
}
