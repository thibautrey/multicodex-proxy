#ifndef MULTIVIBE_LINUX_MENU_H
#define MULTIVIBE_LINUX_MENU_H

enum {
    MULTIVIBE_MENU_ACTION_TOGGLE = 1,
    MULTIVIBE_MENU_ACTION_OPEN_DASHBOARD = 2,
    MULTIVIBE_MENU_ACTION_REFRESH = 3,
    MULTIVIBE_MENU_ACTION_CHECK_UPDATES = 4,
    MULTIVIBE_MENU_ACTION_INSTALL_UPDATE = 5,
    MULTIVIBE_MENU_ACTION_QUIT = 6,
    MULTIVIBE_MENU_ACTION_START_AT_LOGIN_ON = 7,
    MULTIVIBE_MENU_ACTION_START_AT_LOGIN_OFF = 8,
};

int multivibe_menu_init(const char *icon_path);
void multivibe_menu_run(void);
void multivibe_menu_set_model(const char *model);
void multivibe_menu_request_enrollment(void);
void multivibe_menu_show_message(const char *title, const char *message, int warning);
void multivibe_menu_stop(void);

#endif
