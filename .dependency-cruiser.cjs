module.exports = {
  forbidden: [
    {
      name: "engine-no-service",
      comment: "engine must not depend on service",
      severity: "error",
      from: { path: "^packages/engine" },
      to: { path: "^packages/service" },
    },
    {
      name: "runner-no-engine-or-service",
      comment: "runner must not depend on engine or service",
      severity: "error",
      from: { path: "^packages/runner" },
      to: { path: "^packages/(engine|service)" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
  },
};
