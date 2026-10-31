import { Effect } from "effect"
import { Migrator } from "effect/sql"
import init from "./migrations/0001_init.ts"
import automations from "./migrations/0002_automations.ts"
import threadEffort from "./migrations/0004_thread_effort.ts"
import threadAccessMode from "./migrations/0005_thread_access_mode.ts"
import messagesFts from "./migrations/0008_messages_fts.ts"
import turnBaseTree from "./migrations/0007_turn_base_tree.ts"
import threadLimited from "./migrations/0006_thread_limited.ts"
import archive from "./migrations/0009_archive.ts"
import agentAccounts from "./migrations/0010_agent_accounts.ts"
import museProvider from "./migrations/0011_muse_provider.ts"
import accountHome from "./migrations/0012_account_home.ts"
import pullRequestWatch from "./migrations/0013_pull_request_watch.ts"
import threadPin from "./migrations/0014_thread_pin.ts"
import environments from "./migrations/0015_environments.ts"
import threadQueue from "./migrations/0016_thread_queue.ts"
import ftsOnCompletion from "./migrations/0017_fts_on_completion.ts"
import threadUserSkills from "./migrations/0018_thread_user_skills.ts"
import projectLinearReview from "./migrations/0019_project_linear_review.ts"
import pullRequestGuide from "./migrations/0020_pull_request_guide.ts"
import projectKind from "./migrations/0021_project_kind.ts"
import environmentRelay from "./migrations/0022_environment_relay.ts"
import environmentSource from "./migrations/0023_environment_source.ts"
import threadSnooze from "./migrations/0025_thread_snooze.ts"
import fork from "./migrations/0026_fork.ts"
import settingsFiles from "./migrations/0027_settings_files.ts"
import threadDevice from "./migrations/0028_thread_device.ts"
import listenersPickInterface from "./migrations/0029_listeners_pick_interface.ts"
import sideChat from "./migrations/0030_side_chat.ts"
import acpProviders from "./migrations/0032_acp_providers.ts"
import messageOpen from "./migrations/0031_message_open.ts"
import archiveSharedChats from "./migrations/0024_archive_shared_chats.ts"

const run = Migrator.make({})

export const runMigrations = run({
  loader: Migrator.fromRecord({
    "1_init": init,
    "2_automations": automations,
    "4_thread_effort": threadEffort,
    "5_thread_access_mode": threadAccessMode,
    "6_thread_limited": threadLimited,
    "7_turn_base_tree": turnBaseTree,
    "8_messages_fts": messagesFts,
    "9_archive": archive,
    "10_agent_accounts": agentAccounts,
    "11_muse_provider": museProvider,
    "12_account_home": accountHome,
    "13_pull_request_watch": pullRequestWatch,
    "14_thread_pin": threadPin,
    "15_environments": environments,
    "16_thread_queue": threadQueue,
    "17_fts_on_completion": ftsOnCompletion,
    "18_thread_user_skills": threadUserSkills,
    "19_project_linear_review": projectLinearReview,
    "20_pull_request_guide": pullRequestGuide,
    "21_project_kind": projectKind,
    "22_environment_relay": environmentRelay,
    "23_environment_source": environmentSource,
    "25_thread_snooze": threadSnooze,
    "24_archive_shared_chats": archiveSharedChats,
    "26_fork": fork,
    "27_settings_files": settingsFiles,
    "28_thread_device": threadDevice,
    "29_listeners_pick_interface": listenersPickInterface,
    "30_side_chat": sideChat,
    "31_message_open": messageOpen,
    "32_acp_providers": acpProviders,
  }),
}).pipe(
  Effect.tap((ran) =>
    ran.length === 0 ? Effect.void : Effect.logInfo(`migrations ran up to ${ran.at(-1)?.join("_")}`),
  ),
)
