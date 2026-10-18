// spikes/spk-3/fixtures/alloc.mjs — allocates 50 MB every 50 ms until killed.
const hold = [];
setInterval(() => hold.push(Buffer.alloc(50e6, 1)), 50);
