// Starts ONLY the Team Activity watcher (real code, real modules)
// so end-to-end tests can kill and restart it like a crashed server.
import { teamActivityWatcher } from "../../src/services/teamActivityWatcher.service.js";

teamActivityWatcher.start(Number(process.env.POLL_MS ?? 200));
