/**
 * @file types.js — JSDoc type definitions for Fleet Operations
 * Import with: const { FleetRow } = require('./types'); // (documentation only)
 */

/**
 * @typedef {Object} FleetRow
 * @property {string} equipmentId - Unit ID (e.g., "322472", "B62148")
 * @property {string} [altId] - Alternate ID (amz-format)
 * @property {string} [operator] - Operator code (AZNG, AZNU, etc.)
 * @property {string} [domicileSite] - Site code (ABE40, AVP40, etc.)
 * @property {string} [lifecycleState] - Available | Unavailable | Decommissioned
 * @property {string} [lifecycleReason] - Reason for current state
 * @property {string} [vendor] - Assigned repair vendor
 * @property {string} [workDuration] - Days down (e.g., "14 days")
 * @property {string} [etc] - Estimated time of completion
 * @property {number} [riskScore] - Uptake risk score (0-100)
 * @property {string} [issueDetails] - Description of the issue
 * @property {string} [vendorWoId] - Vendor work order ID
 * @property {string} [pmBDue] - PM-B due date
 * @property {string} [pmXDue] - PM-X due date
 * @property {string} [dotDue] - DOT inspection due date
 * @property {string} [bodyType] - Vehicle body type
 */

/**
 * @typedef {Object} NotesEntry
 * @property {string} [timeline] - Newline-separated timeline entries
 * @property {string} [issueSummary] - AI-generated issue summary
 * @property {string} [repairStatus] - Current repair status code
 * @property {string} [primaryComponent] - CAB/CHASSIS/ELECTRICAL/ENGINE/ACCESSORIES
 */

/**
 * @typedef {Object} Contact
 * @property {string} id - Unique ID
 * @property {string} name - Display name
 * @property {string} [slackId] - Slack handle or email
 * @property {string} [company] - Company name
 * @property {string} [phone] - Phone number
 * @property {string} type - "slack" | "vendor"
 */

/**
 * @typedef {Object} RepairHistoryEvent
 * @property {string} date - ISO date (YYYY-MM-DD)
 * @property {string} summary - One-line summary (max 120 chars)
 * @property {string} vendor - Vendor name
 * @property {string} duration - How long unit was down
 * @property {string} outcome - "completed" | "in-progress" | "cancelled"
 * @property {number} ts - Unix timestamp
 */

/**
 * @typedef {Object} AIActionResult
 * @property {boolean} ok - Success flag
 * @property {string} text - Response text to show user
 * @property {string} action - "chat" | "multi"
 */

/**
 * @typedef {Object} AIAction
 * @property {string} type - TIMELINE|SLACK|SYNC|SP_PUSH|EMAIL|READ_SLACK|REMIND|DAILY_NOTES|DRAFT_FOLLOWUPS|CREATE_WR|MOVE_UNIT|PIN|UNPIN|SCHEDULE
 * @property {string} [unit] - Equipment ID
 * @property {string} [recipient] - Slack handle or email
 * @property {string} [message] - Message text
 * @property {string} [entry] - Timeline entry
 * @property {string} [when] - Reminder date (YYYY-MM-DD)
 * @property {string} [note] - Reminder note
 * @property {string} [issue] - WR issue description
 * @property {string} [status] - "available" | "unavailable"
 * @property {string} [to] - Email address
 * @property {string} [subject] - Email subject
 * @property {string} [body] - Email body
 * @property {string} [cron] - Schedule expression
 * @property {string} [action] - Scheduled action description
 */

/**
 * @typedef {Object} Reminder
 * @property {string} unit - Equipment ID
 * @property {string} when - Due date (YYYY-MM-DD)
 * @property {string} note - What to check
 * @property {string} created - ISO timestamp
 */

/**
 * @typedef {Object} SyncResult
 * @property {FleetRow[]} rows - Fleet data rows
 * @property {number} count - Total count
 * @property {string} syncedAt - ISO timestamp
 */

module.exports = {}; // Documentation only
