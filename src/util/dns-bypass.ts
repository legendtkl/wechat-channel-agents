/**
 * Bypass /etc/hosts for DNS resolution.
 *
 * MOADeploy (or similar security tools) periodically overwrites /etc/hosts
 * to redirect certain domains (e.g. ilinkai.weixin.qq.com) to 127.0.0.1.
 *
 * Node.js's built-in `fetch` (undici) uses `dns.lookup` which reads /etc/hosts.
 * This module patches the global fetch dispatcher to use `dns.resolve4` / `dns.resolve6`
 * which query DNS servers directly, bypassing /etc/hosts entirely.
 */

import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import { logger } from "./logger.js";

/**
 * Custom DNS lookup that bypasses /etc/hosts by using dns.resolve4/resolve6.
 * Uses the undici-compatible callback format: callback(err, [{address, family}]).
 */
function dnsLookup(
  hostname: string,
  options: { family?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    result: Array<{ address: string; family: number }>,
  ) => void,
): void {
  const family = options.family ?? 0;

  if (family === 0 || family === 4) {
    dns.resolve4(hostname, (err, addresses) => {
      if (!err && addresses.length > 0) {
        return callback(null, [{ address: addresses[0], family: 4 }]);
      }
      // If family unspecified, fall back to IPv6
      if (family === 0) {
        dns.resolve6(hostname, (err6, addresses6) => {
          if (!err6 && addresses6.length > 0) {
            return callback(null, [{ address: addresses6[0], family: 6 }]);
          }
          // All failed, fall back to default lookup (will read /etc/hosts)
          dns.lookup(hostname, { all: true }, (errLookup, results) => {
            if (errLookup || !results || results.length === 0) {
              return callback(errLookup ?? new Error(`No address found for ${hostname}`), []);
            }
            callback(null, results.map((r) => ({ address: r.address, family: r.family })));
          });
        });
      } else {
        callback(err ?? new Error(`No IPv4 address found for ${hostname}`), []);
      }
    });
  } else {
    dns.resolve6(hostname, (err, addresses) => {
      if (!err && addresses.length > 0) {
        return callback(null, [{ address: addresses[0], family: 6 }]);
      }
      callback(err ?? new Error(`No IPv6 address found for ${hostname}`), []);
    });
  }
}

/**
 * Call once at startup to make all global `fetch()` calls bypass /etc/hosts.
 */
export function installDnsBypass(): void {
  const agent = new Agent({
    connect: {
      lookup: dnsLookup as any,
    },
  });
  setGlobalDispatcher(agent);
  logger.info("DNS bypass installed: fetch will skip /etc/hosts");
}
