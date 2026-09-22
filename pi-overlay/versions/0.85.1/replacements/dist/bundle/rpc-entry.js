#!/usr/bin/env node
import { setupCli } from "../cli/setup.js";
import { APP_NAME } from "../config.js";
import { main } from "../main.js";
setupCli();
process.title = `${APP_NAME}-rpc`;
main(["--mode", "rpc", ...process.argv.slice(2)]);
