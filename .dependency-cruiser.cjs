module.exports = {
  forbidden: [
    {
      name: "engine-no-service-or-web",
      comment: "engine must not depend on service or web",
      severity: "error",
      from: { path: "^packages/engine" },
      to: { path: "^packages/(service|web)" },
    },
    {
      name: "runner-no-engine-service-web",
      comment: "runner must not depend on engine, service or web",
      severity: "error",
      from: { path: "^packages/runner" },
      to: { path: "^packages/(engine|service|web)" },
    },
    {
      name: "service-no-web",
      comment: "service must not depend on web source code",
      severity: "error",
      from: { path: "^packages/service" },
      to: { path: "^packages/web" },
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
