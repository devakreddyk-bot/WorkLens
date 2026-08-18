-- 0002_org_bootstrap.sql — default categorisation template and org seeding
--
-- Creating an organisation requires more than one INSERT: it needs a monitoring_config
-- row (or the agent has nothing to fetch) and a starting set of app/site categories (or
-- every rollup is a single "uncategorised" bar). Doing that from the API in three
-- separate statements invites a half-created org if one of them fails.
--
-- This migration provides a global category template plus wl_seed_org_defaults(), so
-- org creation is one atomic call.

-- ---------------------------------------------------------------------------
-- Global template (not org-scoped — it is reference data, not tenant data)
-- ---------------------------------------------------------------------------

create table default_app_categories (
    id         integer generated always as identity primary key,
    match_type text    not null check (match_type in ('app_exe', 'url_host')),
    pattern    text    not null,
    category   text    not null,
    priority   integer not null default 100,

    constraint default_app_categories_uq unique (match_type, pattern)
);

comment on table default_app_categories is
    'Seed template copied into app_categories for each new organisation. Editing a row '
    'here affects organisations created afterwards, never existing ones — an org owns '
    'its categorisation once it exists.';

insert into default_app_categories (match_type, pattern, category, priority) values
    -- Development
    ('app_exe',  'code.exe',            'Development',   10),
    ('app_exe',  'devenv.exe',          'Development',   10),
    ('app_exe',  'idea64.exe',          'Development',   10),
    ('app_exe',  'pycharm64.exe',       'Development',   10),
    ('app_exe',  'goland64.exe',        'Development',   10),
    ('app_exe',  'sublime_text.exe',    'Development',   10),
    ('app_exe',  'windowsterminal.exe', 'Development',   10),
    ('app_exe',  'powershell.exe',      'Development',   10),
    ('app_exe',  'cmd.exe',             'Development',   10),
    ('url_host', 'github.com',          'Development',   10),
    ('url_host', 'gitlab.com',          'Development',   10),
    ('url_host', 'stackoverflow.com',   'Development',   10),

    -- Communication
    ('app_exe',  'outlook.exe',         'Communication', 20),
    ('app_exe',  'teams.exe',           'Communication', 20),
    ('app_exe',  'ms-teams.exe',        'Communication', 20),
    ('app_exe',  'slack.exe',           'Communication', 20),
    ('app_exe',  'discord.exe',         'Communication', 20),
    ('url_host', 'mail.google.com',     'Communication', 20),
    ('url_host', 'outlook.office.com',  'Communication', 20),
    ('url_host', 'slack.com',           'Communication', 20),

    -- Meetings
    ('app_exe',  'zoom.exe',            'Meetings',      15),
    ('app_exe',  'webex.exe',           'Meetings',      15),
    ('url_host', 'meet.google.com',     'Meetings',      15),
    ('url_host', 'zoom.us',             'Meetings',      15),

    -- Productivity
    ('app_exe',  'winword.exe',         'Productivity',  30),
    ('app_exe',  'excel.exe',           'Productivity',  30),
    ('app_exe',  'powerpnt.exe',        'Productivity',  30),
    ('app_exe',  'onenote.exe',         'Productivity',  30),
    ('app_exe',  'notion.exe',          'Productivity',  30),
    ('url_host', 'docs.google.com',     'Productivity',  30),
    ('url_host', 'sheets.google.com',   'Productivity',  30),
    ('url_host', 'notion.so',           'Productivity',  30),
    ('url_host', 'atlassian.net',       'Productivity',  30),
    ('url_host', 'trello.com',          'Productivity',  30),
    ('url_host', 'asana.com',           'Productivity',  30),

    -- Design
    ('app_exe',  'figma.exe',           'Design',        25),
    ('app_exe',  'photoshop.exe',       'Design',        25),
    ('app_exe',  'illustrator.exe',     'Design',        25),
    ('url_host', 'figma.com',           'Design',        25),

    -- Browsing (catch-all for browsers when no URL rule matched; low priority so a
    -- specific host rule always wins)
    ('app_exe',  'chrome.exe',          'Browsing',      900),
    ('app_exe',  'msedge.exe',          'Browsing',      900),
    ('app_exe',  'firefox.exe',         'Browsing',      900),
    ('app_exe',  'brave.exe',           'Browsing',      900),

    -- Personal / non-work. Present as a category so a deployer can see the split
    -- without having to build the rules themselves; deliberately NOT used to exclude
    -- anything, only to label it.
    ('url_host', 'youtube.com',         'Personal',      800),
    ('url_host', 'netflix.com',         'Personal',      800),
    ('url_host', 'instagram.com',       'Personal',      800),
    ('url_host', 'facebook.com',        'Personal',      800),
    ('url_host', 'reddit.com',          'Personal',      800),
    ('url_host', 'x.com',               'Personal',      800),
    ('url_host', 'twitter.com',         'Personal',      800);

-- ---------------------------------------------------------------------------
-- Atomic org bootstrap
-- ---------------------------------------------------------------------------

create or replace function wl_seed_org_defaults(p_org_id uuid)
    returns void
    language plpgsql
as $$
begin
    if not exists (select 1 from organizations where id = p_org_id) then
        raise exception 'wl_seed_org_defaults: organization % does not exist', p_org_id
            using errcode = 'foreign_key_violation';
    end if;

    -- Least-invasive defaults come from the column defaults in monitoring_config;
    -- this deliberately overrides none of them.
    insert into monitoring_config (org_id)
    values (p_org_id)
    on conflict (org_id) do nothing;

    insert into app_categories (org_id, match_type, pattern, category, priority)
    select p_org_id, d.match_type, d.pattern, d.category, d.priority
    from default_app_categories d
    on conflict (org_id, match_type, pattern) do nothing;
end;
$$;

comment on function wl_seed_org_defaults(uuid) is
    'Idempotent. Gives an organisation its monitoring_config row (at the least-invasive '
    'defaults) and a copy of the default category template. Safe to re-run.';

-- ---------------------------------------------------------------------------
-- Nonce sweep, called by the hourly scheduled Lambda
-- ---------------------------------------------------------------------------

create or replace function wl_sweep_device_nonces(p_older_than interval default interval '10 minutes')
    returns bigint
    language plpgsql
as $$
declare
    v_deleted bigint;
begin
    delete from device_nonces where seen_at < now() - p_older_than;
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

comment on function wl_sweep_device_nonces(interval) is
    'Deletes replay-protection nonces older than the accepted timestamp window. The '
    'default interval must stay comfortably larger than the ±300s window enforced by '
    'the HMAC middleware, or replays become possible at the window boundary.';

