const MESSAGES = {
  MSG_PING: 0,
  MSG_TAP: 1,
  MSG_SHOW: 2,
  MSG_NEED_DISPLAY: 3,
  MSG_UPDATE_VOTING: 4,
  MSG_BEGIN_VOTING: 5,
  MSG_BEGIN_STANDBY: 6,
  MSG_CHECK_HOLD: 7,
  MSG_BEGIN_HOLDING: 8,
  MSG_FINISH: 9,
  MSG_PAUSE: 10,
  MSG_SELECT_HISTORY: 11,
  MSG_SHOW_NUMBER_CONNECTION: 12,
};

const FORM_MESSAGES = {
  INVALID_SESSION_DATA: "Session or password invalid",
  INVALID_SESSION: "Invalid session",
  INVALID_ADMIN_USER: "Username or password invalid",
};

const ABOUT_DATA_DIR = "about Nested notation";

module.exports = {
  MESSAGES,
  ABOUT_DATA_DIR,
  FORM_MESSAGES,
};
