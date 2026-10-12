import net from 'node:net';

// Non-printing loopback receiver for native UI transport/duplicate-submit QA.
// Never forwards bytes, opens a printer, or logs receipt/label contents.
let connections = 0;
const server = net.createServer(socket => {
  const id = ++connections;
  let bytes = 0;
  socket.on('data', chunk => { bytes += chunk.length; });
  socket.on('end', () => console.log(JSON.stringify({ connection: id, bytes, at: new Date().toISOString() })));
  socket.on('error', error => console.log(JSON.stringify({ connection: id, error: error.code || 'transport-error' })));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ host: '127.0.0.1', port: address.port, purpose: 'native-qa-no-hardware', contentsLogged: false }));
});
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
