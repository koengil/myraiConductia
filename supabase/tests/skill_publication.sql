\ir skill_publication/setup.sql
\ir skill_publication/base.sql
grant execute on function skill_authoring_browser_draft(uuid) to anon, authenticated;
\ir skill_publication/base_functions.sql
\ir skill_publication/base_rail.sql
grant execute on function rail_remove_step(uuid, uuid, uuid, text[]) to anon, authenticated;
grant execute on function rail_restore_step(uuid, uuid, uuid) to anon, authenticated;
grant execute on function rail_skip_step(uuid, uuid, uuid, uuid, text) to anon, authenticated;
set check_function_bodies = off;
\ir ../migrations/20260916120000_skill_publication.sql
set check_function_bodies = on;
\ir ../migrations/20260916130000_deal_step_skill_runs.sql
set check_function_bodies = off;
\ir ../migrations/20260916140000_skill_enhancement_and_version_selection.sql
set check_function_bodies = on;
\ir skill_publication/rail_search_path_fixup.sql
\ir skill_publication/search_path_fixup.sql
\ir skill_publication/helpers.sql
\ir skill_publication/helpers_functions.sql
\ir skill_publication/cases.sql
\ir skill_publication/cases_integrity.sql
\ir skill_publication/cases_functions.sql
\ir skill_publication/cases_projection.sql
\ir skill_publication/cases_attachment.sql
\ir skill_publication/cases_rail_insert.sql
