// spikes/spk-4/cred-helper.mjs — THROWAWAY git credential helper: token from parent over a named pipe with one-time nonce.
import net from 'node:net';
const op = process.argv[2];
if (op !== 'get') process.exit(0); // ignore store/erase
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const fields = Object.fromEntries(input.split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const sock = net.connect(process.env.AIK_SPIKE_CRED_PIPE, () => sock.end(JSON.stringify({ nonce: process.env.AIK_SPIKE_CRED_NONCE, host: fields.host })));
  let reply = '';
  sock.on('data', (d) => (reply += d));
  sock.on('end', () => {
    const r = JSON.parse(reply || '{}');
    if (r.password) process.stdout.write(`username=x-access-token\npassword=${r.password}\nquit=1\n`);
    process.exit(0);
  });
  sock.on('error', () => process.exit(0));
});
