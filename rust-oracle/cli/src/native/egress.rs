//! DNS-resolution SSRF egress guard (Silver Delta 2).
//!
//! The engine (like upstream Vercel agent-browser) validates navigation targets
//! only lexically. That leaves a real hole: a PUBLIC hostname that RESOLVES to a
//! private / cloud-metadata address slips straight through. Wildcard-DNS
//! services make this trivial — `http://169.254.169.254.nip.io/` and
//! `http://127.0.0.1.nip.io/` are ordinary hostnames lexically, yet resolve to
//! the cloud metadata endpoint / loopback.
//!
//! [`assert_navigable_resolved`] resolves the target host and REJECTS when any
//! resolved address is loopback / link-local / private / CGNAT / reserved —
//! unless the host is `localhost` / `*.localhost` (RFC 6761, needed for local
//! testing) or the operator opted the domain in via `--allowed-domains`. This
//! is a Rust port of `skill/agent-browser/src/security/egress.ts`
//! (`assertNavigableResolved` / `isBlockedAddress`). Keyless: no model.
//!
//! Residual (accepted, documented): Chromium performs its OWN DNS resolution
//! when it navigates, so a hostile authoritative server could rebind between
//! this pre-check and Chromium's connect (TOCTOU). The Rust-side `read` fetch
//! path shares the OS resolver with this check, so there it is tight; the
//! browser-navigation path keeps this residual. A full close would need
//! `--host-resolver-rules` pinning, which breaks legitimate resolution and
//! `localhost`, and is not adopted.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// `localhost` / `*.localhost` are RFC 6761 special-use loopback names. They are
/// NOT a DNS-rebinding vector (a rebind hides a private IP behind a PUBLIC
/// name); the agent typed the loopback name explicitly. We permit them and skip
/// resolution.
pub fn is_explicit_loopback_name(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost")
}

/// True iff `ip` is loopback (127.0.0.0/8, ::1, or an IPv4-mapped loopback).
pub fn is_loopback_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return mapped.is_loopback();
            }
            v6.is_loopback()
        }
    }
}

/// True iff `ip` is a loopback / link-local / private / CGNAT / unspecified /
/// reserved / multicast address (v4 or v6, including IPv4-mapped IPv6). Mirrors
/// `isBlockedAddress` in egress.ts.
pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(*v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — judge the embedded v4.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_blocked_v4(mapped);
            }
            is_blocked_v6(*v6)
        }
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    if a == 0 {
        return true; // 0.0.0.0/8 — "this host" / reserved
    }
    if a == 10 {
        return true; // 10/8 private
    }
    if a == 127 {
        return true; // 127/8 loopback
    }
    if a == 169 && b == 254 {
        return true; // 169.254/16 link-local (cloud metadata)
    }
    if a == 172 && (16..=31).contains(&b) {
        return true; // 172.16/12 private
    }
    if a == 192 && b == 168 {
        return true; // 192.168/16 private
    }
    if a == 100 && (64..=127).contains(&b) {
        return true; // 100.64/10 CGNAT
    }
    if a >= 224 {
        return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
    }
    false
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() {
        return true; // ::
    }
    if ip.is_loopback() {
        return true; // ::1
    }
    let first = ip.segments()[0];
    if (first & 0xffc0) == 0xfe80 {
        return true; // fe80::/10 link-local
    }
    if (first & 0xfe00) == 0xfc00 {
        return true; // fc00::/7 unique-local
    }
    false
}

/// Match a host against `--allowed-domains` patterns using the engine's
/// `DomainFilter` semantics: exact match, or a `*.suffix` wildcard.
fn host_matches_allowed(host: &str, patterns: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    for pattern in patterns {
        let pattern = pattern.trim().to_ascii_lowercase();
        if pattern.is_empty() {
            continue;
        }
        if let Some(suffix) = pattern.strip_prefix("*.") {
            if host == suffix || host.ends_with(&format!(".{}", suffix)) {
                return true;
            }
        } else if host == pattern {
            return true;
        }
    }
    false
}

/// The message returned on a blocked navigation. Deliberately does NOT echo the
/// host, resolved IP, or any request detail — no path/secret leak.
fn blocked_message() -> String {
    "navigation blocked: target resolves to a non-public (loopback, link-local, private, \
     CGNAT, or reserved) address — blocked by the SSRF egress guard"
        .to_string()
}

/// Async navigability guard. Returns `Ok(())` to permit, `Err(message)` to
/// block. Never panics.
///
/// Only http/https targets are resolved and vetted; other schemes (file:,
/// about:, data:, chrome:, …) are left to the engine's existing handling so
/// this guard never changes their behaviour. `localhost` / `*.localhost` and
/// explicitly-typed loopback IP literals are permitted for local testing; a
/// PUBLIC hostname that resolves to loopback (the nip.io attack) is blocked.
pub async fn assert_navigable_resolved(url: &str, allowed_domains: &[String]) -> Result<(), String> {
    let parsed = match url::Url::parse(url.trim()) {
        Ok(u) => u,
        // Not a well-formed absolute URL — let the caller's own parsing report.
        Err(_) => return Ok(()),
    };

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Ok(());
    }

    let host = match parsed.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return Ok(()),
    };
    // `url` gives IPv6 hosts without brackets via host_str(); guard anyway.
    // Owned so it outlives the resolver future below.
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if bare.is_empty() {
        return Ok(());
    }

    // Local-testing / operator-trusted escape hatches (checked before resolving).
    if is_explicit_loopback_name(&bare) {
        return Ok(());
    }
    if host_matches_allowed(&bare, allowed_domains) {
        return Ok(());
    }

    // Raw IP literal: no DNS deception is possible. Permit an explicitly-typed
    // loopback literal (direct local testing); block other non-public literals
    // (e.g. a raw 169.254.169.254 metadata address or a 10./192.168. host).
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if is_loopback_ip(&ip) {
            return Ok(());
        }
        if is_blocked_ip(&ip) {
            return Err(blocked_message());
        }
        return Ok(());
    }

    // Hostname: resolve and reject if ANY resolved address is non-public. Port 0
    // is a placeholder — only the resolved IPs matter. Collect into an owned
    // Vec immediately so no borrow of `bare` outlives the resolver future.
    let resolved = tokio::net::lookup_host((bare.as_str(), 0u16)).await;
    let addrs: Vec<std::net::SocketAddr> = match resolved {
        Ok(iter) => iter.collect(),
        // Resolution failure: the OS resolver could not turn this into an
        // address, so no private target is reached here. Let the browser /
        // reqwest surface the real DNS error instead of a false-positive block.
        Err(_) => return Ok(()),
    };
    for addr in &addrs {
        if is_blocked_ip(&addr.ip()) {
            return Err(blocked_message());
        }
    }
    // No addresses is unusual but not proof of danger; let the caller's connect
    // surface the real error rather than mislabeling it a security block.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn test_blocked_v4_ranges() {
        assert!(is_blocked_ip(&ip("127.0.0.1")));
        assert!(is_blocked_ip(&ip("169.254.169.254"))); // cloud metadata
        assert!(is_blocked_ip(&ip("10.0.0.5")));
        assert!(is_blocked_ip(&ip("172.16.0.1")));
        assert!(is_blocked_ip(&ip("172.31.255.255")));
        assert!(is_blocked_ip(&ip("192.168.1.1")));
        assert!(is_blocked_ip(&ip("100.64.0.1"))); // CGNAT
        assert!(is_blocked_ip(&ip("0.0.0.0")));
        assert!(is_blocked_ip(&ip("224.0.0.1")));
        // Public addresses are allowed.
        assert!(!is_blocked_ip(&ip("93.184.216.34"))); // example.com
        assert!(!is_blocked_ip(&ip("8.8.8.8")));
        assert!(!is_blocked_ip(&ip("172.15.0.1"))); // just below private range
        assert!(!is_blocked_ip(&ip("172.32.0.1"))); // just above private range
    }

    #[test]
    fn test_blocked_v6_ranges() {
        assert!(is_blocked_ip(&ip("::1"))); // loopback
        assert!(is_blocked_ip(&ip("::"))); // unspecified
        assert!(is_blocked_ip(&ip("fe80::1"))); // link-local
        assert!(is_blocked_ip(&ip("fc00::1"))); // unique-local
        assert!(is_blocked_ip(&ip("fd12::1"))); // unique-local
        assert!(is_blocked_ip(&ip("::ffff:127.0.0.1"))); // v4-mapped loopback
        assert!(is_blocked_ip(&ip("::ffff:169.254.169.254"))); // v4-mapped metadata
        assert!(!is_blocked_ip(&ip("2606:2800:220:1:248:1893:25c8:1946"))); // public
    }

    #[test]
    fn test_loopback_detection() {
        assert!(is_loopback_ip(&ip("127.0.0.1")));
        assert!(is_loopback_ip(&ip("127.5.5.5")));
        assert!(is_loopback_ip(&ip("::1")));
        assert!(is_loopback_ip(&ip("::ffff:127.0.0.1")));
        assert!(!is_loopback_ip(&ip("10.0.0.1")));
    }

    #[test]
    fn test_explicit_loopback_name() {
        assert!(is_explicit_loopback_name("localhost"));
        assert!(is_explicit_loopback_name("app.localhost"));
        assert!(!is_explicit_loopback_name("localhost.evil.com"));
        assert!(!is_explicit_loopback_name("example.com"));
    }

    #[test]
    fn test_host_matches_allowed() {
        let allowed = vec!["internal.corp".to_string(), "*.example.com".to_string()];
        assert!(host_matches_allowed("internal.corp", &allowed));
        assert!(host_matches_allowed("api.example.com", &allowed));
        assert!(host_matches_allowed("example.com", &allowed));
        assert!(!host_matches_allowed("evil.com", &allowed));
        assert!(!host_matches_allowed("example.com.evil.com", &allowed));
    }

    #[tokio::test]
    async fn test_non_http_scheme_permitted() {
        assert!(assert_navigable_resolved("about:blank", &[]).await.is_ok());
        assert!(assert_navigable_resolved("data:text/html,hi", &[]).await.is_ok());
        assert!(assert_navigable_resolved("file:///etc/hosts", &[]).await.is_ok());
        assert!(assert_navigable_resolved("chrome://version", &[]).await.is_ok());
    }

    #[tokio::test]
    async fn test_localhost_name_permitted() {
        assert!(assert_navigable_resolved("http://localhost:8080/", &[]).await.is_ok());
        assert!(assert_navigable_resolved("http://app.localhost/x", &[]).await.is_ok());
    }

    #[tokio::test]
    async fn test_loopback_literal_permitted_but_metadata_literal_blocked() {
        // Explicit loopback literal is allowed (direct local testing).
        assert!(assert_navigable_resolved("http://127.0.0.1:3000/", &[]).await.is_ok());
        // Raw metadata / private literals are blocked.
        assert!(assert_navigable_resolved("http://169.254.169.254/latest/meta-data/", &[])
            .await
            .is_err());
        assert!(assert_navigable_resolved("http://10.0.0.5/", &[]).await.is_err());
    }

    #[tokio::test]
    async fn test_allowed_domain_bypasses_resolution() {
        // Even if it would resolve to something private, an allowlisted host is
        // permitted (operator opt-in).
        let allowed = vec!["internal.corp".to_string()];
        assert!(assert_navigable_resolved("http://internal.corp/", &allowed).await.is_ok());
    }
}
