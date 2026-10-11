# Deterministic DNS fixture

This fixture provides stable records for the MosDNS IPv4/IPv6 preference matrix and listens on both UDP and TCP.

```bash
python3 tests/fixtures/dns/dns_fixture.py --host 127.0.0.1 --port 15353
npm run test:dns-fixture
```

| Name | A | AAAA |
|---|---|---|
| `dual.test` | `192.0.2.10` | `2001:db8::10` |
| `v4-only.test` | `192.0.2.20` | NODATA |
| `v6-only.test` | NODATA | `2001:db8::20` |
| `cname-dual.test` | CNAME to `dual.test` | CNAME to `dual.test` |
| `no-address.test` | NODATA | NODATA |

Unknown names return NXDOMAIN. The fixture uses documentation-only address ranges and does not contact public DNS.

## MosDNS routing-memory regression

The Go regression uses real MosDNS sequences and deterministic upstream plugins;
no public DNS or production service is used. It checks both modes, A/AAAA,
subscription precedence over stale/conflicting memory, failed/empty answers,
strict-mode failure propagation without domestic fallback, and persistence
after replacing or clearing a running core's memory files. Compatibility mode
retains its existing resolution path.

Additional regressions cover client cancellation before/during shutdown, write
failure recovery, keeping stopped services stopped, custom IPv4/IPv6 FakeIP
ranges at the audit/upstream API boundary, and v0.6.6 configuration migration.
The migration fixtures verify that edited upstreams, timeouts, file permissions,
and custom sequences survive, including when structured settings are stale.
The v0.6.7 upgrade regression also checks cleanup of old learned denials and
fallback cache dumps. Strict mode ignores permanent no-address memory and its
front cache does not serve expired responses.

Real UDP upstream fixtures distinguish SERVFAIL, REFUSED, transport timeouts,
NXDOMAIN and NOERROR/NODATA (including SOA preservation), and verify recovery
after a negative answer expires without a manual reset.

```bash
MSF_RUNTIME=native MSF_TEST_MOSDNS=/absolute/path/to/mosdns \
  go test ./internal/server -run 'TestMosDNSLearning|TestMosDNSFakeIPParsing|TestMosDNSSafe' -count=1
```

## Known upstream timeout defect (separate diagnostic)

The reference official core is `yyysuo/mosdns` commit
`b93784b95b1a827ef684e42636b3e16ab4e04be1`. Its forward plugin closes the
shared upstream transport after a single request timeout; later queries fail
with `transport has been closed`. MSF's configuration changes do not repair
this core defect. MSF does not ship a patched core or automatically apply a core
patch; this limitation awaits an upstream fix.

The response-classification cases above use independent core processes so a
transport timeout does not contaminate the next case. The separate recovery
probe intentionally fails on the affected reference core and can be used to
verify a future upstream release:

```bash
MSF_RUNTIME=native MSF_TEST_MOSDNS=/absolute/path/to/mosdns \
  MSF_TEST_MOSDNS_TIMEOUT_PROBE=1 \
  go test ./internal/server -run '^TestMosDNSCoreTimeoutRecovery$' -count=1 -v
```

Without `MSF_TEST_MOSDNS`, real-core tests are skipped; classification and
migration unit tests still run. The upstream recovery probe also requires
`MSF_TEST_MOSDNS_TIMEOUT_PROBE=1`; passing the ordinary MSF suite does not mean
that the installed core has fixed timeout recovery.
