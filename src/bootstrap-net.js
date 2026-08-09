'use strict';

const dns = require('node:dns');
const net = require('node:net');

/**
 * Node races IPv4 and IPv6 connections ("Happy Eyeballs") with a 250ms
 * per-attempt deadline. On networks with a blackholed IPv6 route — WSL2 and
 * some ISPs — every attempt can expire before the working IPv4 handshake
 * completes, and fetch fails with an aggregate ETIMEDOUT even though curl to
 * the same host succeeds.
 *
 * Connecting to one address family in a known order avoids the race. Set
 * NET_AUTOSELECT_FAMILY=1 to restore Node's default behaviour.
 */
if (process.env.NET_AUTOSELECT_FAMILY !== '1') {
  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamily(false);
}
