import { runNodeCli } from "../packages/runner/src/run-node-cli.ts";

process.exit(await runNodeCli(process.argv.slice(2)));
