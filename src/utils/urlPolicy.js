const net = require('net');

// The server never fetches a destination URL, so there's no SSRF to defend
// against here. This is a policy about which links a public shortener should
// hand out at all: nothing that points into the visitor's own machine or
// network, nothing that hides the real host, and no links back to ourselves.
//
// Only literal addresses are checked. A public hostname that resolves to a
// private IP isn't caught, which is fine as long as nothing server-side ever
// fetches these URLs. If link previews are added, that code needs its own
// check after DNS resolution.
const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3], // multicast and reserved, up to 255.255.255.255
]) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
// BlockList also applies the IPv4 rules to IPv4-mapped addresses, so
// [::ffff:127.0.0.1] is caught by 127.0.0.0/8 above
for (const [network, prefix] of [
  ['::', 127], // :: and ::1
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
]) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, ''); // URL keeps the brackets on IPv6
  const kind = net.isIP(bare);
  if (kind) return blocked.check(bare, kind === 4 ? 'ipv4' : 'ipv6');
  if (host === 'localhost' || !host.includes('.')) return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Returns an error message, or null if the url is allowed.
function checkDestination(parsed, { ownHost } = {}) {
  if (parsed.username || parsed.password) {
    // https://google.com@evil.example goes to evil.example
    return 'urls with a username or password are not allowed';
  }
  if (isBlockedHost(parsed.hostname)) {
    return 'urls pointing to localhost or private networks are not allowed';
  }
  if (ownHost && parsed.host.toLowerCase() === ownHost.toLowerCase()) {
    return 'cannot shorten a link to this service';
  }
  return null;
}

module.exports = { checkDestination, isBlockedHost };
