const { createOrchestratorDecision } = require("./orchestratorService");

async function routeUserIntent(payload = {}, options = {}) {
  return createOrchestratorDecision(payload, options);
}

module.exports = {
  routeUserIntent,
};
