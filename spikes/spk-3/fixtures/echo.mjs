// spikes/spk-3/fixtures/echo.mjs — echoes stdin to stdout, writes bytes 0..255 to stderr, exits with code 7.
process.stderr.write(Buffer.from([...Array(256).keys()]));
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => process.exit(7));
