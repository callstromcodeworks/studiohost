import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortMapper, discoverGateways, findWanService, isBehindAnotherNat } from '../data/app/server/portmap.js';
import { startFakeRouter } from './fake-router.mjs';

test('SSDP discovery finds the gateway description', async () => {
  const router = await startFakeRouter();
  try {
    const found = await discoverGateways({ ssdpAddress: router.ssdp.address, ssdpPort: router.ssdp.port, timeoutMs: 800 });
    assert.deepEqual(found, [router.location]);
    const svc = await findWanService(found[0]);
    assert.equal(svc.serviceType, 'urn:schemas-upnp-org:service:WANIPConnection:1');
    assert.match(svc.controlUrl, /\/ctl\/IPConn$/);
  } finally { router.close(); }
});

test('UPnP: opens the port with a lease, reads the public address, removes it on close', async () => {
  const router = await startFakeRouter();
  try {
    const mapper = new PortMapper({ port: 43210, ssdp: router.ssdp, disableNatPmp: true });
    const m = await mapper.open();
    assert.equal(m.method, 'upnp');
    assert.equal(m.externalIp, '203.0.113.10');
    const entry = router.mappings.get('TCP:43210');
    assert.ok(entry);
    assert.equal(entry.internalPort, 43210);
    assert.equal(entry.client, '127.0.0.1');
    assert.equal(entry.lease, 3600);
    assert.equal(entry.description, 'Studio Host');
    await mapper.close();
    assert.equal(router.mappings.size, 0);
  } finally { router.close(); }
});

test('UPnP: falls back to a permanent mapping on routers that require one', async () => {
  const router = await startFakeRouter({ permanentOnly: true });
  try {
    const m = await new PortMapper({ port: 43211, upnpLocation: router.location, disableNatPmp: true }).open();
    assert.equal(m.leaseSeconds, 0);
    assert.equal(router.mappings.get('TCP:43211').lease, 0);
  } finally { router.close(); }
});

test('NAT-PMP is used when no UPnP router answers', async () => {
  const router = await startFakeRouter({ upnp: false });
  try {
    const mapper = new PortMapper({ port: 43212, ssdp: router.ssdp, natPmpGateway: router.natPmp.gateway, natPmpPort: router.natPmp.port });
    const m = await mapper.open();
    assert.equal(m.method, 'natpmp');
    assert.equal(m.externalIp, '203.0.113.10');
    assert.equal(router.mappings.get('TCP:43212').via, 'natpmp');
    await mapper.close();
    assert.equal(router.mappings.size, 0);
  } finally { router.close(); }
});

test('a clear error when the router refuses', async () => {
  const router = await startFakeRouter({ refusePorts: [43213], natpmp: false });
  try {
    const mapper = new PortMapper({ port: 43213, upnpLocation: router.location, natPmpGateway: router.natPmp.gateway, natPmpPort: router.natPmp.port });
    await assert.rejects(mapper.open(), /Could not open port 43213.*718/s);
  } finally { router.close(); }
});

test('detects a router that is itself behind another NAT', () => {
  assert.ok(isBehindAnotherNat('100.72.1.5'));
  assert.ok(isBehindAnotherNat('192.168.0.2'));
  assert.ok(!isBehindAnotherNat('203.0.113.10'));
});
