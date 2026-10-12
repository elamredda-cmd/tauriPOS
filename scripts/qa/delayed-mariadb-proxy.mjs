import net from 'node:net';

// Test-only loopback proxy. It delays the native TCP handshake without reading,
// decoding, logging or persisting any database traffic or credentials.
const listenerPort = Number(process.argv[2] || 65161);
const serverPort = Number(process.argv[3] || 65160);
const delayMs = Number(process.argv[4] || 2000);
if (![listenerPort, serverPort].every(value => Number.isInteger(value) && value > 1024 && value <= 65535)
    || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10000) {
    throw new Error('Expected two local test ports and a bounded handshake delay.');
}
const sockets = new Set();
const server = net.createServer(client => {
    sockets.add(client);
    client.pause();
    let backend;
    const timer = setTimeout(() => {
        if (client.destroyed) return;
        backend = net.connect({ host: '127.0.0.1', port: serverPort });
        sockets.add(backend);
        backend.on('connect', () => { client.pipe(backend); backend.pipe(client); client.resume(); });
        backend.on('error', () => client.destroy());
        backend.on('close', () => { sockets.delete(backend); client.destroy(); });
    }, delayMs);
    client.on('error', () => backend?.destroy());
    client.on('close', () => { clearTimeout(timer); sockets.delete(client); backend?.destroy(); });
});
server.listen(listenerPort, '127.0.0.1', () => {
    console.log(JSON.stringify({ loopbackListener: listenerPort, testServerPort: serverPort, handshakeDelayMs: delayMs, trafficLogged: false }));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); for (const socket of sockets) socket.destroy(); });
}
