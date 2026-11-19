/**
 * A program that runs a rack, as another program would: it starts the command it is given with
 * its standard input a pipe, and stdout and stderr shared with its own, prints the command's
 * process id, and waits until the test kills it. It starts the command detached: on Windows,
 * Bun ends the children it didn't detach together with itself.
 *
 * @decision .agents/decisions/261118_173838-running-under-another-program.md#tests
 */
const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
  detached: true,
  stdin: "pipe",
  stdout: "inherit",
  stderr: "inherit",
});
console.log(`child pid ${child.pid}`);
await child.exited;
