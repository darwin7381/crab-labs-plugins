# YouTube Transcript — VPN Setup Guide

The `fetch_transcript.py` script routes requests through a residential IP to bypass YouTube's cloud IP blocks. This requires a VPN (WireGuard recommended).

## Configuration

Set these in your `.claude/media-alchemist.local.md`:

```yaml
---
vpn_interface: wg0           # Your WireGuard interface name
vpn_source_ip: 10.x.x.x     # Your VPS's WireGuard IP
---
```

Or set environment variables:
```bash
export VPN_INTERFACE="wg0"
export VPN_SOURCE_IP="10.x.x.x"
```

## Requirements

- WireGuard installed on your VPS
- A residential network endpoint (home router with WireGuard support)
- Policy-based routing configured so VPN-bound traffic uses the residential IP

## Setup Steps

1. Generate WireGuard keys on both ends (residential + VPS)
2. Configure WireGuard interface on both ends
3. Add policy routing on VPS: `ip rule add from <VPN_IP> table <TABLE_ID>`
4. Verify: `curl --interface <VPN_IP> ifconfig.me` should show residential IP
5. Set config in `.local.md` or env vars

## Troubleshooting

- If `fetch_transcript.py` errors with "VPN not available": check `wg show <interface>`
- If YouTube still blocks: verify the source IP is residential, not datacenter
- Alternative: run the script from a residential machine directly (no VPN needed)
