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
  MSG_CHANGE_FOLDER: 13,
  MSG_CHANGE_VOLUME: 14,
  MSG_GLOBAL_REFRESH: 15,
  // Session Lines orchestration protocol (Phase 3). Inert for vanilla scores —
  // only emitted when session.hasSessionLines.
  MSG_LINE_ASSIGNED: 16, // tell a device its (new) line id on split/merge
  MSG_BEGIN_SPLIT: 17, // a split frame's choice window opened
  MSG_BARRIER_WAITING: 18, // line parked at a hold-until barrier
  MSG_BARRIER_RELEASED: 19, // barrier satisfied — line may proceed
  MSG_SUB_ENTER: 20, // line dived into a sub-score
  MSG_SUB_EXIT: 21, // line popped back to the main flow
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
