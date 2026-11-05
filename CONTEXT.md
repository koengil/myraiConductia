# Conductia

Conductia organizes work on a sell-side project through a rail of steps, some powered by skills.

## Language

**Project**:
The deal workspace whose participants work through one rail. This feature's scope is that individual project.

**Rail**:
The project's ordered workflow of steps grouped into phases.

**Step**:
A unit of work in a project rail. A step created through skill authoring has one input and one attached skill.

**Skill**:
The instructions that perform a defined job when invoked. The skill is distinct from the output produced by running it.

**Skill identity**:
The stable opaque identity of a published skill, independent of its project-local display name.

**Skill version**:
An immutable published skill package identified by a version ID and content digest.

**Skill binding**:
The skill reference a project step resolves to: either a project skill identity, version and content digest, or a firm-catalog skill name, version number and content digest. It lives in `deal_step_skill_bindings` rather than only in a custom step's definition, and it is re-pointable: an explicit action can change which version or skill a step runs, though the binding still never follows a newer version automatically.

**Capability contract**:
The structured purpose, input, and output of a skill used to identify overlapping work within a project.

**Skill-authoring draft**:
An author-private, project-scoped unfinished skill and the conversation used to describe and refine it before saving it as a rail step.

**Authoring message**:
An immutable instruction the author has submitted within a skill-authoring draft. It is distinct from unsent composer text and may have more than one generation attempt.

**Generation attempt**:
One provider execution for an authoring message. Retrying a failed response creates another attempt for the same message rather than another message.

**Publication operation**:
One durable, idempotent command that publishes an exact skill candidate and attaches the resulting skill version to one project step.

**Skill candidate**:
An unpublished, validated skill package proposal produced during authoring and identified by immutable content digest. It is not runnable until a separate publication operation attaches it to a project step.

**Skill run**:
An invocation of a saved skill on an input, producing a result. It is distinct from the conversation that created the skill.

**Removed step**:
A step excluded from a project’s active rail whose work and history are retained for inspection and restoration. Removing a step is distinct from completing it or deleting its skill.

**Archived skill-authoring draft**:
An explicitly discarded draft retained as private history. It no longer resumes through Add step and cannot publish a skill, even if an already-started response finishes later.

**Skill lineage**:
The ordered set of every published version of one skill identity, newest first. Enhancing a skill publishes a new version onto its lineage; it never replaces or removes an earlier one.

**Enhancement draft**:
A skill-authoring draft that improves an existing skill version rather than creating a new skill. It carries a basis and the step it belongs to, and has no placement, because that step already exists and its title, phase and position never move.

**Draft basis**:
The resolved skill reference an enhancement draft is built on: the version it starts from, the step it targets, and, when the draft was opened from a recorded run, the seed run whose result prompted the improvement.

**Catalog fork**:
What happens when the skill behind a catalog step is enhanced and published. A new project-scoped skill identity is seeded from the chosen firm-catalog version, and the step rebinds to it, because the firm catalog is read only from inside a deal and is never written to from one.

**Revision**:
A version of a skill run's output that came from applying edits to an earlier version, or from restoring one. The run's first output is not a revision.

**Head**:
The latest successful revision of a skill run, or the run's first output when it has none. The head is what the step shows.

**Passage**:
The whole Markdown blocks an edit covers, as one contiguous range of the output's source text.

**Edit**:
One change a banker asks for on one passage. A comment edit carries the banker's sentence and the AI writes the replacement. A hand edit carries the banker's own replacement text.

**Unresolved**:
A comment edit the AI declined to apply, with its reason.

**Taught comment**:
An applied comment edit the banker ticked to teach the step's skill. It is offered to a draft at most once, through Teach the skill, and counts as sent once a message on that draft is admitted. A discarded draft's comments are offered again.
