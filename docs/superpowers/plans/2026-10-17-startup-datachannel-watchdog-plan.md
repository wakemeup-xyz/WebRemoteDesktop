# Startup DataChannel watchdog implementation plan

> Use superpowers:subagent-driven-development. Binding spec: ../specs/2026-10-17-startup-datachannel-watchdog-design.md

## Global Constraints

Only worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop; preserve existing README/runbook/requirements/review-anchor dirt + node_modules symlink. One source/index writer. No services/browser/native input/tunnel/watcher actions by workers/reviewers. No npm test/pretest/install/live dist builds. Workers/reviewers must not dispatch subagents; controller owns delegation. Node /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node. Controller owns docs/deploy/live. All existing input/quality/network/security contracts remain.

### Task 1: Scope startup and channel deadlines, preserve bounded phase diagnostics

Files: web-client/js/webrtc.js, runtime-diagnostic.js, diagnostic-core.js; diagnostic.js only if builder integration requires; focused existing/new *.test.js; signal-server/lib/diagnostic.js and focused diagnostic tests. No newmodules/assets/dependencies unless mandatory ambiguity surfaced beforeimplementation.

1. Read binding spec exactcontract. Add one owner-bound watchdog record/timer, finite30s negotiation fromchannelcreation, then10s channel-open aftersuccessfulcurrentanswer; existing2×10s connecting/checking extensions onlypostanswer. Connected/alreadynegotiatedpeer DC rebuild startschannelphaseimmediately. Distinctnegotiation-timeout reason. Cancel/ownerfence all existinglifecyclepaths; unexpectedclosebeforePCconnected retainoriginalboundedwatchdog, connectedclosekeepsowned3srecovery; intentionalteardown onlycancels. Watchdogowner doesnotbindpre-offer epoch; answerawaiter checksits owncaptured epoch. Absolute monotonicdeadline atcallback/answertransition prevents delayedtimer reopeningbudget. Invalid/backwardsclock keepsalreadyfinite timer andunknownelapsed, cannotextendbudgetonanswer orrearmforever. Avoid resetonduplicateanswer; before/afterawaitpeer/socket/attempt/epoch ownership.
2. Keep existingnoteDataChannelFault/scheduleReconnect recoverypolicy andotherinput/mediahandlers. Capturefixedphase snapshot oncebeforefailure; existingautosendcooldownhandlesduplicate recoverynotification. No postexpiryarm, no resurrectedtimer afteropen/refresh. No morethanone ownedtimer/channel.
3. Exposefixed14field startup.dataChannelWatchdog per spec. Use mandatorysharedpure whitelist sanitizer inexistingruntime-diagnostic.js; buildercore/panel, localStorage projection,serverredactStartup/persist actualreport retainit. reasonnegotiation-timeout whitelist permitted. No rawnetwork/IDs/SDP/error/input. Nullmissing, clocksbound, enumstrict, <1KiB, totalexisting128KiB. Existingreceipts/replay remainidentical.
4. TDD newdelayedanswer>10s/<30s regression first; cover every necessarycase in spec pluscurrenttimerzeroID/queuedlatecallbacks iftestclock supports. MinimalVMfakes, no native. Include actualredaction/persistence integration tests withtemporaryprivatepaths only. Runfocusedwebrtc/datachannel/diagnostic/runtime suites directly node --test; no pretest/build. Existing relatedwebrtc assertions mustremainmeaningful; don't weakenfailures.
5. Selfreview; explicitpathcommit; report exacttests/counts, sourcecommit, scope/limitations. Nevereditcontrollerdocs orpreexistingdirt. Controller independenttaskreview+fixloop follows.

### Task 2: Controller review, deployment and runtime check

1. Independent task and most-capableincrementreview includingpriorstartup evidence andunresolvedHostpressure; no repeat ofalreadyreviewedoldbranch. Fiximportantfindings; preservesolution/plan/report.
2. IsolatedViewerbuild + frozenapply baseactualprimarydb5d2b1 (plusdocs-only sync ifperformed). PreserveHEAD/index/unrelatedfiles/WATCH4; privatebackup. FreshHostonline/Viewer0/relay0; restartSignalonly viahelper; Hostautoreconnect verify, noHost/tunnelbounce.
3. Verify source/build/manifest/retaindassets/health/Host/credentials, actualboundeddiagnostics schema ifsafelypossible. One guardedsession cancheckstartup andcapturelogs; noforcedordinaryadmission/nativeinput. No tests/build/reloads duringprobe. Preserveanyfailure andcurrentserviceavailability.
4. Updatediagnosticreports with fixedprematuretimeout vsremaininghost/systemstall separately; neverclaim3h/nativeinput/overallstable withoutactualevidence.
