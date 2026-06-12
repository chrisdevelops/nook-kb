# Nook Memory

A single agent-agnostic memory graph: typed nodes connected by edges, captured and queried through the `mem` CLI by any agent.

## Language

**Kind**:
The structural type of a node — its payload schema, status vocabulary, and machinery enrollment. Kinds are grammar; a new kind is justified only by a distinct payload shape, lifecycle, or machinery, never by topic.
_Avoid_: type, category, schema (alone)

**Tag**:
Free vocabulary attached to a node. Topics, domains, and hierarchies (`story/<slug>/…`) live here, not in kinds.

**Mood**:
A point-in-time self-report of overall wellbeing: a single 1–5 valence rating (1 = awful, 5 = great) plus optional feeling labels. The rating answers "how good or bad was I doing"; _which_ feeling (sad, anxious, irritated) is a label, never a different number.
_Avoid_: emotion (as the node), feeling (as the node)

**Sleep**:
One night's sleep, attributed to the morning it ended (`occurred_at` = wake time) so it sits temporally adjacent to the day it affects. Duration is its identity; quality is a 1–5 rating.

**Activity**:
A physical activity session (hike, run, climb) identified by a canonical lowercase name. Effort and enjoyment are independent 1–5 axes — a brutal, glorious hike scores high on both.
_Avoid_: workout, exercise (as the node)

**Medication**:
An ongoing medication regimen — one node per regimen, with an `active|stopped` lifecycle and start/stop dates. Individual doses taken are never nodes; adherence logging is out of scope.
_Avoid_: prescription, drug, dose (as the node)

**Measurement**:
A point-in-time scalar reading of a named metric (water intake, weight) — one generic kind whose `metric` field is vocabulary, so new scalars never require new grammar. Mood, sleep, and activity are NOT measurements; they have distinct payload shapes and are kinds of their own.
_Avoid_: metric (for the node itself), reading, datapoint
