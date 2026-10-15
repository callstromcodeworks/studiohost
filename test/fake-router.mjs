// A simulated home router for tests: answers SSDP searches, serves a UPnP IGD description,
// handles WANIPConnection SOAP actions, and speaks NAT-PMP. Can be imported or run directly:
//   node test/fake-router.mjs   (prints its endpoints as JSON, runs until killed)
import dgram from 'node:dgram';
import http from 'node:http';

/**
 * @param {{externalIp?: string, permanentOnly?: boolean, upnp?: boolean, natpmp?: boolean, refusePorts?: number[]}} [opts]
 */
export async function startFakeRouter(opts = {}) {
  const externalIp = opts.externalIp ?? '203.0.113.10';
  /** @type {Map<string, any>} */
  const mappings = new Map();
  const calls = [];
  const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';

  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/rootDesc.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><friendlyName>Fake Router</friendlyName>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType><deviceList><device>
<deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/ctl/CommonIfCfg</controlURL></service>
<service><serviceType>${SERVICE}</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId><controlURL>/ctl/IPConn</controlURL></service>
</serviceList></device></deviceList></device></deviceList></device></root>`);
        return;
      }
      if (req.method === 'POST' && req.url === '/ctl/IPConn') {
        const action = /#(\w+)"?$/.exec(String(req.headers.soapaction || ''))?.[1];
        const arg = (n) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(body)?.[1] ?? '';
        calls.push({ action, body });
        const ok = (inner = '') => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${SERVICE}">${inner}</u:${action}Response></s:Body></s:Envelope>`); };
        const fault = (code, desc) => { res.writeHead(500, { 'Content-Type': 'text/xml' }); res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
        if (action === 'GetExternalIPAddress') return ok(`<NewExternalIPAddress>${externalIp}</NewExternalIPAddress>`);
        if (action === 'AddPortMapping') {
          const port = Number(arg('NewExternalPort')), lease = Number(arg('NewLeaseDuration'));
          if (opts.refusePorts?.includes(port)) return fault(718, 'ConflictInMappingEntry');
          if (opts.permanentOnly && lease !== 0) return fault(725, 'OnlyPermanentLeasesSupported');
          mappings.set(`TCP:${port}`, { via: 'upnp', port, client: arg('NewInternalClient'), internalPort: Number(arg('NewInternalPort')), lease, description: arg('NewPortMappingDescription') });
          return ok();
        }
        if (action === 'DeletePortMapping') { mappings.delete(`TCP:${arg('NewExternalPort')}`); return ok(); }
        return fault(401, 'Invalid Action');
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const location = `http://127.0.0.1:${web.address().port}/rootDesc.xml`;

  // SSDP responder (unicast on loopback; real routers listen on the multicast group).
  const ssdp = dgram.createSocket('udp4');
  ssdp.on('message', (msg, rinfo) => {
    if (opts.upnp === false || !/^M-SEARCH/.test(msg.toString())) return;
    const st = /^ST:\s*(.+)$/im.exec(msg.toString())?.[1]?.trim() || 'upnp:rootdevice';
    ssdp.send(Buffer.from(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: ${st}\r\nUSN: uuid:fake::${st}\r\nLOCATION: ${location}\r\nSERVER: FakeRouter/1.0 UPnP/1.1\r\n\r\n`), rinfo.port, rinfo.address);
  });
  await new Promise((r) => ssdp.bind(0, '127.0.0.1', r));

  // NAT-PMP.
  const pmp = dgram.createSocket('udp4');
  pmp.on('message', (msg, rinfo) => {
    if (opts.natpmp === false || msg[0] !== 0) return;
    const epoch = Buffer.alloc(4); epoch.writeUInt32BE(1000);
    if (msg[1] === 0) {
      pmp.send(Buffer.concat([Buffer.from([0, 128, 0, 0]), epoch, Buffer.from(externalIp.split('.').map(Number))]), rinfo.port, rinfo.address);
    } else if (msg[1] === 2) {
      const internal = msg.readUInt16BE(4), external = msg.readUInt16BE(6), life = msg.readUInt32BE(8);
      if (life === 0) mappings.delete(`TCP:${external || internal}`);
      else mappings.set(`TCP:${external}`, { via: 'natpmp', port: external, internalPort: internal, lease: life });
      const out = Buffer.alloc(16); out[1] = 130; epoch.copy(out, 4);
      out.writeUInt16BE(internal, 8); out.writeUInt16BE(life === 0 ? 0 : external, 10); out.writeUInt32BE(life, 12);
      pmp.send(out, rinfo.port, rinfo.address);
    }
  });
  await new Promise((r) => pmp.bind(0, '127.0.0.1', r));

  return {
    location, externalIp, mappings, calls,
    ssdp: { address: '127.0.0.1', port: ssdp.address().port },
    natPmp: { gateway: '127.0.0.1', port: pmp.address().port },
    close: () => { web.close(); ssdp.close(); pmp.close(); },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const r = await startFakeRouter({ externalIp: process.env.FAKE_EXTERNAL_IP || '203.0.113.10' });
  console.log(JSON.stringify({ location: r.location, ssdp: r.ssdp, natPmp: r.natPmp }));
}
