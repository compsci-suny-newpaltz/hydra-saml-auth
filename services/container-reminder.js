// services/container-reminder.js - Monthly email reminders for container owners
// Sends friendly reminders to users with running containers
//
// Supports two email methods:
// 1. Microsoft Graph API (for M365 shared mailboxes like cslab@newpaltz.edu)
// 2. SMTP (fallback for other mail servers)

const Docker = require('dockerode');
const nodemailer = require('nodemailer');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Email configuration from environment
// For Microsoft Graph (M365 shared mailbox):
//   MAIL_METHOD=graph
//   MS_TENANT_ID=your-tenant-id
//   MS_CLIENT_ID=your-app-client-id
//   MS_CLIENT_SECRET=your-app-client-secret
//   MAIL_FROM=cslab@newpaltz.edu
//
// For SMTP:
//   MAIL_METHOD=smtp
//   SMTP_HOST=smtp.office365.com
//   SMTP_PORT=587
//   SMTP_USER=your-email
//   SMTP_PASS=your-password
//   MAIL_FROM=cslab@newpaltz.edu

const MAIL_METHOD = process.env.MAIL_METHOD || 'graph'; // 'graph' or 'smtp'
const FROM_EMAIL = process.env.MAIL_FROM || 'cslab@newpaltz.edu';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Hydra CS Lab';
const REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Microsoft Graph config
const MS_TENANT_ID = process.env.MS_TENANT_ID;
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;

// SMTP config (fallback)
const smtpConfig = {
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
};

let reminderTimer = null;
let isRunning = false;
let graphAccessToken = null;
let graphTokenExpiry = 0;

/**
 * Get Microsoft Graph access token (client credentials flow)
 */
async function getGraphToken() {
  // Return cached token if still valid
  if (graphAccessToken && Date.now() < graphTokenExpiry - 60000) {
    return graphAccessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get Graph token: ${err}`);
  }

  const data = await response.json();
  graphAccessToken = data.access_token;
  graphTokenExpiry = Date.now() + (data.expires_in * 1000);
  return graphAccessToken;
}

/**
 * Send email via Microsoft Graph API (for shared mailbox)
 */
async function sendViaGraph(to, subject, htmlContent, textContent) {
  const token = await getGraphToken();

  // Send as the shared mailbox
  const url = `https://graph.microsoft.com/v1.0/users/${FROM_EMAIL}/sendMail`;

  const message = {
    message: {
      subject,
      body: {
        contentType: 'HTML',
        content: htmlContent
      },
      toRecipients: [{ emailAddress: { address: to } }],
      from: {
        emailAddress: {
          address: FROM_EMAIL,
          name: FROM_NAME
        }
      }
    },
    saveToSentItems: false
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Graph API error: ${err}`);
  }

  return true;
}

/**
 * Create nodemailer transporter for SMTP
 */
function createSmtpTransporter() {
  if (!smtpConfig.auth.user || !smtpConfig.auth.pass) {
    console.warn('[container-reminder] SMTP credentials not configured.');
    return null;
  }
  return nodemailer.createTransport(smtpConfig);
}

/**
 * Check if email is properly configured
 */
function isEmailConfigured() {
  if (MAIL_METHOD === 'graph') {
    return MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET;
  } else {
    return smtpConfig.auth.user && smtpConfig.auth.pass;
  }
}

/**
 * Get all student containers with their owner info
 */
async function getStudentContainers() {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: ['hydra.managed_by=hydra-saml-auth']
      }
    });

    return containers.map(c => ({
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, '') || 'unknown',
      state: c.State,
      status: c.Status,
      created: new Date(c.Created * 1000),
      ownerEmail: c.Labels['hydra.ownerEmail'] || null,
      owner: c.Labels['hydra.owner'] || null
    }));
  } catch (err) {
    console.error('[container-reminder] Failed to list containers:', err);
    return [];
  }
}

/**
 * Send reminder email to a container owner
 */
async function sendReminderEmail(container, smtpTransporter = null) {
  if (!container.ownerEmail) {
    console.log(`[container-reminder] No email for container ${container.name}, skipping`);
    return false;
  }

  const containerRunning = container.state === 'running';
  const createdDate = container.created.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const subject = containerRunning
    ? 'Your Hydra Container is Running - Monthly Reminder'
    : 'Your Hydra Container - Monthly Status Update';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #052049; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 14px; font-weight: 500; }
    .status-running { background: #d1fae5; color: #065f46; }
    .status-stopped { background: #fef3c7; color: #92400e; }
    .footer { background: #f3f4f6; padding: 15px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #6b7280; }
    .btn { display: inline-block; padding: 10px 20px; background: #052049; color: white; text-decoration: none; border-radius: 6px; margin-top: 15px; }
    .warning { background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; border-radius: 6px; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">🐍 Hydra - SUNY New Paltz</h1>
    </div>
    <div class="content">
      <p>Hi ${container.owner || 'Student'},</p>

      <p>This is your monthly reminder about your Hydra development container.</p>

      <p>
        <strong>Container:</strong> ${container.name}<br>
        <strong>Status:</strong> <span class="status ${containerRunning ? 'status-running' : 'status-stopped'}">${containerRunning ? 'Running' : 'Stopped'}</span><br>
        <strong>Created:</strong> ${createdDate}
      </p>

      ${containerRunning ? `
        <p>Your container is currently <strong>running</strong> and using server resources. If you're actively using it, great! Happy coding!</p>
        <p>If you're <strong>not currently using it</strong>, please consider stopping it from the dashboard to free up resources for other students.</p>
      ` : `
        <p>Your container is currently <strong>stopped</strong>. You can start it anytime from the dashboard when you need it.</p>
      `}

      <div class="warning">
        <strong>⚠️ Backup Reminder:</strong> Remember to back up your important files to
        <a href="https://code.visualstudio.com/docs/sourcecontrol/github">GitHub</a> or your personal device.
        Container data may be wiped at the end of the semester.
      </div>

      <a href="https://hydra.newpaltz.edu/dashboard" class="btn">Go to Dashboard</a>
    </div>
    <div class="footer">
      <p>This is an automated message from the Hydra cluster at SUNY New Paltz.</p>
      <p>If you no longer need your container, you can delete it from the dashboard.</p>
    </div>
  </div>
</body>
</html>
  `;

  const textContent = `
Hi ${container.owner || 'Student'},

This is your monthly reminder about your Hydra development container.

Container: ${container.name}
Status: ${containerRunning ? 'Running' : 'Stopped'}
Created: ${createdDate}

${containerRunning
    ? "Your container is currently running. If you're actively using it, great! Happy coding!\n\nIf you're not currently using it, please consider stopping it from the dashboard to free up resources."
    : "Your container is currently stopped. You can start it anytime from the dashboard."
}

BACKUP REMINDER: Remember to back up your important files to GitHub or your personal device. Container data may be wiped at the end of the semester.

Dashboard: https://hydra.newpaltz.edu/dashboard

---
This is an automated message from the Hydra CS Lab at SUNY New Paltz.
  `;

  try {
    if (MAIL_METHOD === 'graph') {
      await sendViaGraph(container.ownerEmail, subject, htmlContent, textContent);
    } else {
      // SMTP fallback
      if (!smtpTransporter) {
        throw new Error('SMTP transporter not available');
      }
      await smtpTransporter.sendMail({
        from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to: container.ownerEmail,
        subject,
        text: textContent,
        html: htmlContent
      });
    }
    console.log(`[container-reminder] Sent reminder to ${container.ownerEmail}`);
    return true;
  } catch (err) {
    console.error(`[container-reminder] Failed to send email to ${container.ownerEmail}:`, err.message);
    return false;
  }
}

/**
 * Run the monthly reminder process
 */
async function runReminders() {
  console.log('[container-reminder] Running monthly container reminders...');
  console.log(`[container-reminder] Using ${MAIL_METHOD} method, from: ${FROM_EMAIL}`);

  if (!isEmailConfigured()) {
    console.log('[container-reminder] Skipping - email not configured');
    console.log('[container-reminder] Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET for Graph API');
    console.log('[container-reminder] Or set SMTP_USER, SMTP_PASS for SMTP');
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Create SMTP transporter if using SMTP method
  const smtpTransporter = MAIL_METHOD === 'smtp' ? createSmtpTransporter() : null;

  const containers = await getStudentContainers();
  console.log(`[container-reminder] Found ${containers.length} student containers`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const container of containers) {
    if (!container.ownerEmail) {
      skipped++;
      continue;
    }

    const success = await sendReminderEmail(container, smtpTransporter);
    if (success) {
      sent++;
    } else {
      failed++;
    }

    // Small delay between emails to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`[container-reminder] Complete: ${sent} sent, ${failed} failed, ${skipped} skipped`);
  return { sent, failed, skipped };
}

/**
 * Start the reminder service (runs monthly)
 */
function start() {
  if (isRunning) {
    console.log('[container-reminder] Already running');
    return;
  }

  console.log('[container-reminder] Starting monthly reminder service');
  isRunning = true;

  // Schedule to run monthly
  reminderTimer = setInterval(runReminders, REMINDER_INTERVAL_MS);

  // Also check if we should run on startup (e.g., if server was down during scheduled time)
  // For now, we'll just wait for the interval
  console.log(`[container-reminder] Next reminder in ${REMINDER_INTERVAL_MS / (24 * 60 * 60 * 1000)} days`);
}

/**
 * Stop the reminder service
 */
function stop() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
  isRunning = false;
  console.log('[container-reminder] Stopped');
}

/**
 * Manually trigger reminders (for admin use)
 */
async function triggerReminders() {
  return await runReminders();
}

module.exports = {
  start,
  stop,
  triggerReminders,
  getStudentContainers
};
