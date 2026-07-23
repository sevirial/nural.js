/**
 * Dev-server banner, printed as a `tsx watch --import=…` preload (see
 * commands/dev.ts). `tsx watch` re-runs preloads on every restart, so wiring the
 * banner here — instead of printing it once from the parent `nural dev` process —
 * makes it reappear on each file-change reload, not just the first boot.
 *
 * Kept dependency-free (raw ANSI, not chalk) so it resolves cleanly when tsx
 * loads it from inside the watched child process. Colors match the monochrome
 * website palette (`app/globals.css`): the banner is bold near-white
 * `--text #f4f4f5` and the version is muted zinc `--accent-2 #a1a1aa`.
 * `1` = bold, `0` = reset.
 */
const MONO = "\x1b[1m\x1b[38;2;244;244;245m";
const MUTED = "\x1b[38;2;161;161;170m";
const RESET = "\x1b[0m";

console.log(
  `${MONO}
  ░███    ░██                                ░██       ░██
  ░████   ░██                                ░██
  ░██░██  ░██ ░██    ░██ ░██░████  ░██████   ░██       ░██  ░███████
  ░██ ░██ ░██ ░██    ░██ ░███           ░██  ░██       ░██ ░██
  ░██  ░██░██ ░██    ░██ ░██       ░███████  ░██       ░██  ░███████
  ░██   ░████ ░██   ░███ ░██      ░██   ░██  ░██       ░██        ░██
  ░██    ░███  ░█████░██ ░██       ░█████░██ ░██ ░██   ░██  ░███████
                                                       ░██
                                                     ░███
  ${RESET}`,
);

const version = process.env.NURALJS_DEV_VERSION;
if (version) console.log(`${MUTED}  v${version}${RESET}`);
