export function assertSupportedRuntime(version = process.versions.node): void {
  const match = /^22\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 23 || (Number(match[1]) === 23 && Number(match[2]) < 4)) {
    throw new Error(`Yolow requires Node.js 22.23.4 or newer in the 22.x release line; running ${version}. See README.md.`);
  }
}

assertSupportedRuntime();
