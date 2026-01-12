// services/email-notifications.js - Email notifications for resource requests
// Sends notifications for resource request submissions and approval/denial results

const nodemailer = require('nodemailer');

// Email configuration from environment
const MAIL_METHOD = process.env.MAIL_METHOD || 'graph'; // 'graph' or 'smtp'
const FROM_EMAIL = process.env.MAIL_FROM || 'cslab@newpaltz.edu';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Hydra CS Lab';
const ADMIN_EMAIL = process.env.APPROVAL_EMAIL || 'cslab@newpaltz.edu';

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

let graphAccessToken = null;
let graphTokenExpiry = 0;

/**
 * Get Microsoft Graph access token (client credentials flow)
 */
async function getGraphToken() {
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
 * Send email via Microsoft Graph API
 */
async function sendViaGraph(to, subject, htmlContent) {
    const token = await getGraphToken();
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
 * Create SMTP transporter
 */
function createSmtpTransporter() {
    if (!smtpConfig.auth.user || !smtpConfig.auth.pass) {
        return null;
    }
    return nodemailer.createTransport(smtpConfig);
}

/**
 * Check if email is configured
 */
function isEmailConfigured() {
    if (MAIL_METHOD === 'graph') {
        return MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET;
    }
    return smtpConfig.auth.user && smtpConfig.auth.pass;
}

/**
 * Send email using configured method
 */
async function sendEmail(to, subject, htmlContent) {
    if (!isEmailConfigured()) {
        console.warn('[email-notifications] Email not configured, skipping');
        return false;
    }

    try {
        if (MAIL_METHOD === 'graph') {
            await sendViaGraph(to, subject, htmlContent);
        } else {
            const transporter = createSmtpTransporter();
            if (!transporter) {
                throw new Error('SMTP not configured');
            }
            await transporter.sendMail({
                from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
                to,
                subject,
                html: htmlContent
            });
        }
        return true;
    } catch (error) {
        console.error(`[email-notifications] Failed to send email to ${to}:`, error.message);
        return false;
    }
}

/**
 * Get node display info
 */
function getNodeInfo(nodeName) {
    const nodes = {
        hydra: { label: 'Hydra', description: 'Control Plane (No GPU)', emoji: '🐍' },
        chimera: { label: 'Chimera', description: 'GPU Inference (3x RTX 3090)', emoji: '🔥' },
        cerberus: { label: 'Cerberus', description: 'GPU Training (2x RTX 5090)', emoji: '⚡' }
    };
    return nodes[nodeName] || { label: nodeName, description: '', emoji: '🖥️' };
}

/**
 * Send notification to admin for new resource request
 */
async function sendApprovalNotification(request) {
    const nodeInfo = getNodeInfo(request.target_node);

    const subject = `[Hydra] Resource Request from ${request.username}`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #052049; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
        .info-box { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 15px; margin: 15px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
        .info-row:last-child { border-bottom: none; }
        .label { color: #6b7280; font-size: 14px; }
        .value { font-weight: 500; }
        .footer { background: #f3f4f6; padding: 15px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #6b7280; }
        .btn { display: inline-block; padding: 10px 20px; background: #052049; color: white; text-decoration: none; border-radius: 6px; margin-top: 15px; }
        .btn-approve { background: #059669; }
        .btn-deny { background: #dc2626; margin-left: 10px; }
        .request-type { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; background: #dbeafe; color: #1e40af; }
        .gpu-badge { background: #fef3c7; color: #92400e; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0;">🐍 Hydra Resource Request</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">New request requires admin approval</p>
        </div>
        <div class="content">
            <p><strong>User:</strong> ${request.username} (${request.email})</p>

            <span class="request-type ${request.requested_gpu_count > 0 ? 'gpu-badge' : ''}">${request.request_type.replace('_', ' ').toUpperCase()}</span>

            <div class="info-box">
                <div class="info-row">
                    <span class="label">Target Node</span>
                    <span class="value">${nodeInfo.emoji} ${nodeInfo.label} - ${nodeInfo.description}</span>
                </div>
                <div class="info-row">
                    <span class="label">Memory</span>
                    <span class="value">${request.requested_memory_gb} GB</span>
                </div>
                <div class="info-row">
                    <span class="label">CPUs</span>
                    <span class="value">${request.requested_cpus} cores</span>
                </div>
                <div class="info-row">
                    <span class="label">Storage</span>
                    <span class="value">${request.requested_storage_gb} GB</span>
                </div>
                ${request.requested_gpu_count > 0 ? `
                <div class="info-row">
                    <span class="label">GPUs</span>
                    <span class="value">${request.requested_gpu_count} GPU(s)</span>
                </div>
                ` : ''}
                ${request.preset_id ? `
                <div class="info-row">
                    <span class="label">Preset</span>
                    <span class="value">${request.preset_id}</span>
                </div>
                ` : ''}
            </div>

            ${request.reason ? `
            <div class="info-box">
                <p style="margin: 0;"><strong>Reason:</strong></p>
                <p style="margin: 10px 0 0 0; color: #4b5563;">${request.reason}</p>
            </div>
            ` : ''}

            <p>
                <a href="https://hydra.newpaltz.edu/dashboard/admin" class="btn btn-approve">Review Request</a>
            </p>
        </div>
        <div class="footer">
            <p>Request ID: #${request.id}</p>
            <p>This request will expire in 7 days if not reviewed.</p>
        </div>
    </div>
</body>
</html>
    `;

    const sent = await sendEmail(ADMIN_EMAIL, subject, htmlContent);
    if (sent) {
        console.log(`[email-notifications] Sent approval notification for request #${request.id}`);
    }
    return sent;
}

/**
 * Send notification to user when request is approved
 */
async function sendApprovalResult(request, approved, adminNotes = null) {
    const nodeInfo = getNodeInfo(request.target_node);
    const status = approved ? 'Approved' : 'Denied';
    const statusColor = approved ? '#059669' : '#dc2626';
    const statusEmoji = approved ? '✅' : '❌';

    const subject = `[Hydra] Resource Request ${status}`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: ${statusColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
        .info-box { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 15px; margin: 15px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
        .info-row:last-child { border-bottom: none; }
        .label { color: #6b7280; font-size: 14px; }
        .value { font-weight: 500; }
        .footer { background: #f3f4f6; padding: 15px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #6b7280; }
        .btn { display: inline-block; padding: 10px 20px; background: #052049; color: white; text-decoration: none; border-radius: 6px; margin-top: 15px; }
        .notes { background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; border-radius: 6px; margin-top: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0;">${statusEmoji} Resource Request ${status}</h1>
        </div>
        <div class="content">
            <p>Hi ${request.username},</p>

            ${approved ? `
            <p>Great news! Your resource request has been <strong>approved</strong>. You can now use the following configuration:</p>
            ` : `
            <p>Unfortunately, your resource request has been <strong>denied</strong>. Please see the details below:</p>
            `}

            <div class="info-box">
                <div class="info-row">
                    <span class="label">Target Node</span>
                    <span class="value">${nodeInfo.emoji} ${nodeInfo.label}</span>
                </div>
                <div class="info-row">
                    <span class="label">Memory</span>
                    <span class="value">${request.requested_memory_gb} GB</span>
                </div>
                <div class="info-row">
                    <span class="label">CPUs</span>
                    <span class="value">${request.requested_cpus} cores</span>
                </div>
                <div class="info-row">
                    <span class="label">Storage</span>
                    <span class="value">${request.requested_storage_gb} GB</span>
                </div>
                ${request.requested_gpu_count > 0 ? `
                <div class="info-row">
                    <span class="label">GPUs</span>
                    <span class="value">${request.requested_gpu_count}</span>
                </div>
                ` : ''}
            </div>

            ${adminNotes ? `
            <div class="notes">
                <strong>Admin Notes:</strong><br>
                ${adminNotes}
            </div>
            ` : ''}

            ${approved ? `
            <p>Your container will use these new resources on the next restart. If you need to migrate your container to a GPU node, please restart your container from the dashboard.</p>
            ` : `
            <p>If you have questions about this decision, please contact the CS Lab staff.</p>
            `}

            <a href="https://hydra.newpaltz.edu/dashboard" class="btn">Go to Dashboard</a>
        </div>
        <div class="footer">
            <p>This is an automated message from the Hydra cluster at SUNY New Paltz.</p>
            <p>For assistance, contact compsci@newpaltz.edu</p>
        </div>
    </div>
</body>
</html>
    `;

    const sent = await sendEmail(request.email, subject, htmlContent);
    if (sent) {
        console.log(`[email-notifications] Sent ${status.toLowerCase()} notification to ${request.email}`);
    }
    return sent;
}

/**
 * Send notification when container migration completes
 */
async function sendMigrationComplete(username, email, fromNode, toNode, success) {
    const fromInfo = getNodeInfo(fromNode);
    const toInfo = getNodeInfo(toNode);
    const statusEmoji = success ? '✅' : '❌';

    const subject = success
        ? `[Hydra] Container Migration Complete`
        : `[Hydra] Container Migration Failed`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: ${success ? '#059669' : '#dc2626'}; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
        .migration-path { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 20px; margin: 15px 0; text-align: center; }
        .node { display: inline-block; padding: 10px 20px; background: #f3f4f6; border-radius: 6px; }
        .arrow { display: inline-block; padding: 0 20px; color: #9ca3af; font-size: 24px; }
        .footer { background: #f3f4f6; padding: 15px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #6b7280; }
        .btn { display: inline-block; padding: 10px 20px; background: #052049; color: white; text-decoration: none; border-radius: 6px; margin-top: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0;">${statusEmoji} Container Migration ${success ? 'Complete' : 'Failed'}</h1>
        </div>
        <div class="content">
            <p>Hi ${username},</p>

            ${success ? `
            <p>Your container has been successfully migrated!</p>
            ` : `
            <p>Unfortunately, your container migration encountered an error. Please contact support.</p>
            `}

            <div class="migration-path">
                <span class="node">${fromInfo.emoji} ${fromInfo.label}</span>
                <span class="arrow">→</span>
                <span class="node">${toInfo.emoji} ${toInfo.label}</span>
            </div>

            ${success ? `
            <p>Your container is now running on <strong>${toInfo.label}</strong>. All your data has been preserved.</p>
            ${toNode !== 'hydra' ? `<p><strong>Note:</strong> You now have access to GPU resources. Check the dashboard for GPU status.</p>` : ''}
            ` : `
            <p>Your container remains on ${fromInfo.label}. An admin has been notified.</p>
            `}

            <a href="https://hydra.newpaltz.edu/dashboard" class="btn">Go to Dashboard</a>
        </div>
        <div class="footer">
            <p>This is an automated message from the Hydra cluster at SUNY New Paltz.</p>
        </div>
    </div>
</body>
</html>
    `;

    return await sendEmail(email, subject, htmlContent);
}

module.exports = {
    sendApprovalNotification,
    sendApprovalResult,
    sendMigrationComplete,
    isEmailConfigured
};
