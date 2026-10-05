#!/usr/bin/env node
import { parseArgs } from "node:util";

// React reads NODE_ENV when it loads, and the development build is several times slower.
process.env.NODE_ENV ??= "production";
const { createElement } = await import("react");
const { render } = await import("ink");
const { App } = await import("./app.js");
const { Config, absolute } = await import("./core.js");

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

let config: InstanceType<typeof Config>;
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

// No JSX in this file: the JSX runtime import would load React before NODE_ENV is set.
// Incremental rendering rewrites only changed lines instead of repainting the whole screen.
const app = render(createElement(App, { config, project: values.project }),
  { alternateScreen: true, incrementalRendering: true });
await app.waitUntilExit();
