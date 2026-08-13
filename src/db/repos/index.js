// Tum repository modullerini tek noktadan re-export.

module.exports = {
  settings: require("./settings"),
  services: require("./services"),
  users: require("./users"),
  bans: require("./bans"),
  audit: require("./audit"),
  integrations: require("./integrations")
};
