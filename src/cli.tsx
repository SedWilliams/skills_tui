#!/usr/bin/env node
import { parseArgs } from "node:util";
import { render } from "ink";
import { App } from "./app.js";
import { Config, absolute } from "./core.js";

const USAGE = `Usage: tui-skills [--root DIR]... [--project DIR] [--config-dir DIR]

Find, edit, and install local coding-agent skills in your terminal.

Options:
  --root DIR        Additional scan directory for this session, repeatable
  --project DIR     Project directory for project-local agent targets
  --config-dir DIR  Alternate app configuration and data directory
  -h, --help        Show this message`;

function fail(message: string): never {
  console.error(`tui-skills: ${message}\n\n${USAGE}`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      root: { type: "string", multiple: true, default: [] },
      project: { type: "string", default: "" },
      "config-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  }));
} catch (exc) {
  fail((exc as Error).message);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

let config: Config;
try {
  config = Config.load(values["config-dir"] ? absolute(values["config-dir"]) : undefined);
} catch (exc) {
  fail(`Could not load configuration: ${(exc as Error).message}`);
}
config.roots.push(...values.root.map(absolute));

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("tui-skills needs an interactive terminal.");
  process.exit(1);
}

const app = render(<App config={config} project={values.project} />, { alternateScreen: true });
await app.waitUntilExit();
