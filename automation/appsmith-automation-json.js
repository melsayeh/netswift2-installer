#!/usr/bin/env node
/**
 * Appsmith Full Automation Script - Playwright Version
 * 
 * This script uses Playwright to automate the Appsmith web UI:
 * 1. Create admin account
 * 2. Import application from JSON file
 * 3. Configure datasource
 * 4. Deploy application
 * 
 * ADVANTAGES over Puppeteer version:
 * - Auto-waiting for elements (no manual sleep() calls needed)
 * - Better error messages with action logs
 * - Built-in trace recording for debugging
 * - More reliable selectors
 * - Better handling of modern SPAs like Appsmith
 * 
 * Usage:
 *   npm install playwright
 *   npx playwright install chromium
 *   node appsmith-automation-playwright.js
 * 
 * Environment Variables:
 *   APPSMITH_URL          - Appsmith URL (default: http://localhost)
 *   ADMIN_EMAIL           - Admin email (default: admin@netswift.com)
 *   ADMIN_PASSWORD        - Admin password (required)
 *   ADMIN_NAME            - Admin name (default: NetSwift Admin)
 *   APP_JSON_PATH         - Path to application JSON file (required)
 *   DATASOURCE_NAME       - Datasource name (default: NetSwift Backend API)
 *   DATASOURCE_URL        - Datasource URL (default: http://172.17.0.1:8000)
 *   HEADLESS              - Run in headless mode (default: true)
 *   TIMEOUT               - Page timeout in ms (default: 90000)
 *   RECORD_TRACE          - Record trace for debugging (default: true on failure)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const config = {
    appsmithUrl: process.env.APPSMITH_URL || 'http://localhost',
    admin: {
        email: process.env.ADMIN_EMAIL || 'admin@netswift.com',
        password: process.env.ADMIN_PASSWORD,
        name: process.env.ADMIN_NAME || 'NetSwift Admin'
    },
    app: {
        jsonPath: process.env.APP_JSON_PATH
    },
    datasource: {
        name: process.env.DATASOURCE_NAME || 'NetSwift Backend API',
        url: process.env.DATASOURCE_URL || 'http://172.17.0.1:8000'
    },
    playwright: {
        headless: process.env.HEADLESS !== 'false',
        timeout: parseInt(process.env.TIMEOUT || '90000'),
        recordTrace: process.env.RECORD_TRACE !== 'false'
    }
};

// Validate required configuration
function validateConfig() {
    const required = [
        { key: 'admin.password', value: config.admin.password, name: 'ADMIN_PASSWORD' },
        { key: 'app.jsonPath', value: config.app.jsonPath, name: 'APP_JSON_PATH' }
    ];

    const missing = required.filter(r => !r.value);
    if (missing.length > 0) {
        console.error('❌ Missing required environment variables:');
        missing.forEach(m => console.error(`   - ${m.name}`));
        process.exit(1);
    }
    
    // Check if JSON file exists
    if (!fs.existsSync(config.app.jsonPath)) {
        console.error(`❌ JSON file not found: ${config.app.jsonPath}`);
        process.exit(1);
    }
}

// Utility functions
const utils = {
    log: (step, message) => {
        console.log(`[${new Date().toISOString()}] [${step}] ${message}`);
    },
    
    error: (step, message, error) => {
        console.error(`[${new Date().toISOString()}] [${step}] ❌ ${message}`);
        if (error) console.error(error);
    },
    
    success: (step, message) => {
        console.log(`[${new Date().toISOString()}] [${step}] ✅ ${message}`);
    },
    
    // Note: Playwright has auto-waiting, so we rarely need manual sleep
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    
    takeScreenshot: async (page, name) => {
        try {
            const screenshotPath = `/tmp/${name}-${Date.now()}.png`;
            await page.screenshot({ path: screenshotPath, fullPage: true });
            utils.log('SCREENSHOT', `Saved to ${screenshotPath}`);
            return screenshotPath;
        } catch (e) {
            utils.log('SCREENSHOT', 'Failed to save screenshot');
        }
    }
};

// Step 1: Wait for Appsmith to be ready
async function waitForAppsmith(page) {
    const step = 'WAIT';
    utils.log(step, `Waiting for Appsmith to be ready at ${config.appsmithUrl}`);
    
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
        try {
            const response = await page.goto(`${config.appsmithUrl}/api/v1/health`, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            
            if (response && response.ok()) {
                const content = await page.content();
                if (content.includes('success') || content.includes('ok')) {
                    utils.success(step, 'Appsmith is ready');
                    return true;
                }
            }
        } catch (error) {
            // Health check failed, wait and retry
        }
        
        attempts++;
        utils.log(step, `Attempt ${attempts}/${maxAttempts}...`);
        await utils.sleep(5000);
    }
    
    throw new Error('Appsmith did not become ready within timeout period');
}

// Step 2: Create admin account (Playwright version with auto-waiting)
async function createAdminAccount(page) {
    const step = 'CREATE_ADMIN';
    utils.log(step, 'Creating admin account...');
    
    try {
        // First, try to navigate to root and see where it redirects
        utils.log(step, 'Checking Appsmith initial state...');
        
        await page.goto(config.appsmithUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        // Wait a moment for any redirects to complete
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        
        const currentUrl = page.url();
        utils.log(step, `Current URL after root: ${currentUrl}`);
        
        // Check if admin already exists (redirects to login or applications)
        if (currentUrl.includes('/user/login')) {
            utils.log(step, 'Admin account exists, attempting login...');
            
            try {
                // Wait for login form to be visible
                await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });
                
                // Fill login form - Playwright auto-waits for elements to be ready
                await page.fill('input[type="email"], input[name="email"]', config.admin.email);
                await page.fill('input[type="password"]', config.admin.password);
                
                utils.log(step, 'Login credentials entered');
                
                // Click login button and wait for navigation
                await Promise.all([
                    page.waitForURL(/\/(applications|home|workspace)/, { timeout: 10000 }),
                    page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")')
                ]);
                
                utils.success(step, 'Logged in with existing admin account');
                return true;
                
            } catch (loginError) {
                utils.log(step, 'Could not login, proceeding to signup');
            }
        } else if (currentUrl.includes('/applications') || currentUrl.includes('/home')) {
            utils.success(step, 'Already logged in');
            return true;
        }
        
        // Navigate to signup page
        utils.log(step, 'Navigating to signup page...');
        
        // Try multiple possible signup URLs
        const signupUrls = [
            `${config.appsmithUrl}/setup/welcome`,
            `${config.appsmithUrl}/user/signup`,
            `${config.appsmithUrl}/signup`
        ];
        
        let signupPageLoaded = false;
        for (const url of signupUrls) {
            try {
                utils.log(step, `Trying URL: ${url}`);
                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                
                // Check if we landed on a signup page by looking for email input
                const emailInput = await page.locator('input[type="email"]').first();
                if (await emailInput.isVisible({ timeout: 2000 })) {
                    signupPageLoaded = true;
                    utils.log(step, `Signup page loaded: ${url}`);
                    break;
                }
            } catch (e) {
                utils.log(step, `Failed to load ${url}`);
                continue;
            }
        }
        
        if (!signupPageLoaded) {
            throw new Error('Could not find signup page at any URL');
        }
        
        utils.log(step, 'Signup page ready, filling form...');
        
        // Wait for signup form to be fully loaded
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
        
        // Fill name fields - try multiple possible selectors
        utils.log(step, 'Filling name fields...');
        
        // Fill first name
        const firstNameSelectors = [
            'input[name="name"]',
            'input[placeholder*="First" i]',
            'input[placeholder*="name" i]'
        ];
        
        for (const selector of firstNameSelectors) {
            try {
                const input = page.locator(selector).first();
                if (await input.isVisible({ timeout: 1000 })) {
                    await input.fill('NetSwift');
                    utils.log(step, 'First name entered: NetSwift');
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        // Fill last name if field exists
        const lastNameSelectors = [
            'input[placeholder*="Last" i]',
            'input[name="lastName"]'
        ];
        
        for (const selector of lastNameSelectors) {
            try {
                const input = page.locator(selector).first();
                if (await input.isVisible({ timeout: 1000 })) {
                    await input.fill('Admin');
                    utils.log(step, 'Last name entered: Admin');
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        // Fill email - Playwright auto-waits for element to be ready
        utils.log(step, 'Filling email...');
        await page.fill('input[type="email"]', config.admin.email);
        utils.log(step, 'Email entered');
        
        // Fill password fields
        utils.log(step, 'Filling password...');
        const passwordFields = await page.locator('input[type="password"]').all();
        
        if (passwordFields.length > 0) {
            await passwordFields[0].fill(config.admin.password);
            utils.log(step, 'Password entered');
        }
        
        // Fill verify password if it exists
        if (passwordFields.length > 1) {
            await passwordFields[1].fill(config.admin.password);
            utils.log(step, 'Verify password entered');
        }
        
        // Take screenshot before submission
        await utils.takeScreenshot(page, 'before-signup-submit');
        
        utils.log(step, 'Form filled, submitting...');
        
        // Find and click the submit button
        // Playwright will auto-wait for button to be enabled and stable
        const submitSelectors = [
            'button:has-text("Continue")',
            'button:has-text("Sign Up")',
            'button:has-text("Get Started")',
            'button:has-text("Create Account")',
            'button[type="submit"]'
        ];
        
        let submitted = false;
        for (const selector of submitSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 2000 }) && await button.isEnabled()) {
                    await button.click();
                    submitted = true;
                    utils.log(step, `Clicked submit button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!submitted) {
            throw new Error('Could not find enabled submit button');
        }
        
        utils.log(step, 'Form submitted, waiting for signup to complete...');
        
        // PLAYWRIGHT ADVANTAGE: Use waitForURL with pattern matching
        // This is much more reliable than manual waiting and URL checking
        try {
            // Wait for URL to change away from signup pages OR for onboarding elements to appear
            await Promise.race([
                // Wait for URL change (timeout 20 seconds)
                page.waitForURL(url => 
                    !url.includes('/setup/welcome') && !url.includes('/user/signup'),
                    { timeout: 20000 }
                ),
                // OR wait for onboarding questions to appear
                page.waitForSelector('text=Novice, text=Expert, text=Personal Project', { timeout: 20000 })
            ]);
            
            utils.log(step, 'Signup completed - page transitioned');
            
        } catch (timeoutError) {
            utils.log(step, 'Timeout waiting for signup - checking current state...');
            await utils.takeScreenshot(page, 'signup-timeout');
            
            const currentUrl = page.url();
            utils.log(step, `Current URL after timeout: ${currentUrl}`);
            
            // If still on signup page, signup failed
            if (currentUrl.includes('/setup/welcome') || currentUrl.includes('/user/signup')) {
                throw new Error('Signup FAILED - still on signup page after submission');
            }
        }
        
        const afterSubmitUrl = page.url();
        utils.log(step, `URL after signup: ${afterSubmitUrl}`);
        await utils.takeScreenshot(page, 'after-signup-submit');
        
        // Check for error messages
        const pageText = await page.textContent('body');
        if (pageText.toLowerCase().includes('already exists')) {
            throw new Error('Email already exists - cannot create admin account');
        }
        
        // Handle onboarding questions
        utils.log(step, 'Handling onboarding questions...');
        
        try {
            // Question 1: Development proficiency - select "Novice"
            // Playwright's text selector is much cleaner!
            const noviceButton = page.locator('button:has-text("Novice"), div[role="button"]:has-text("Novice"), label:has-text("Novice")').first();
            if (await noviceButton.isVisible({ timeout: 5000 })) {
                await noviceButton.click();
                utils.log(step, 'Selected: Novice');
            }
            
            // Small wait between selections
            await page.waitForTimeout(1000);
            
            // Question 2: Use case - select "Personal Project"
            const personalButton = page.locator('button:has-text("Personal Project"), div[role="button"]:has-text("Personal"), label:has-text("Personal")').first();
            if (await personalButton.isVisible({ timeout: 5000 })) {
                await personalButton.click();
                utils.log(step, 'Selected: Personal Project');
            }
            
            await page.waitForTimeout(1000);
            
            // Untick the updates checkbox
            const checkboxes = await page.locator('input[type="checkbox"]:checked').all();
            for (const checkbox of checkboxes) {
                await checkbox.click();
            }
            utils.log(step, 'Unchecked: Security updates checkbox');
            
            await page.waitForTimeout(1000);
            
            // Click Continue button
            const continueButton = page.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Get Started"), button:has-text("Submit")').first();
            if (await continueButton.isVisible({ timeout: 5000 })) {
                await continueButton.click();
                utils.log(step, 'Clicked Continue button');
            }
            
        } catch (e) {
            utils.log(step, 'Onboarding questions not found or already completed');
        }
        
        // Wait for redirect to home/workspace
        utils.log(step, 'Waiting for redirect to applications page...');
        
        try {
            // PLAYWRIGHT ADVANTAGE: Clean URL pattern matching
            await page.waitForURL(/\/(applications|home|workspace)/, { timeout: 15000 });
        } catch (e) {
            utils.log(step, 'Timeout waiting for home page redirect');
        }
        
        const finalUrl = page.url();
        utils.log(step, `Final URL: ${finalUrl}`);
        await utils.takeScreenshot(page, 'signup-final-state');
        
        // STRICT VERIFICATION: Ensure we're NOT still on signup page
        if (finalUrl.includes('/setup/welcome') || finalUrl.includes('/user/signup')) {
            throw new Error('Signup FAILED - still on signup page! Admin account was not created.');
        }
        
        // Verify we're on the expected page
        if (finalUrl.includes('/applications') || 
            finalUrl.includes('/home') || 
            finalUrl.includes('/workspace')) {
            utils.success(step, `Admin account created: ${config.admin.email}`);
            return true;
        }
        
        // Additional verification - look for workspace elements
        try {
            await page.waitForSelector('.workspace, [class*="workspace"], [class*="home"], [class*="application"]', { 
                timeout: 10000 
            });
            utils.success(step, `Admin account created: ${config.admin.email}`);
            return true;
        } catch (e) {
            throw new Error('Could not verify admin account creation - not on expected page');
        }
        
    } catch (error) {
        utils.error(step, 'Failed to create admin account', error);
        await utils.takeScreenshot(page, 'signup-error');
        throw error;
    }
}

// Step 3: Import application from JSON file
async function importFromJson(page) {
    const step = 'JSON_IMPORT';
    utils.log(step, 'Importing application from JSON...');
    
    try {
        // Navigate to applications page if not already there
        const currentUrl = page.url();
        if (!currentUrl.includes('/applications') && !currentUrl.includes('/home')) {
            utils.log(step, 'Navigating to applications page...');
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: config.playwright.timeout
            });
        }
        
        utils.log(step, 'Looking for import option...');
        
        // Look for import button - Playwright text selector is cleaner
        const importSelectors = [
            'button:has-text("Import")',
            'a:has-text("Import")',
            'text=Import',
            '[data-testid="t--import-application"]'
        ];
        
        let importClicked = false;
        for (const selector of importSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    importClicked = true;
                    utils.log(step, `Clicked import button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!importClicked) {
            throw new Error('Could not find import button');
        }
        
        // Wait for file input to appear
        utils.log(step, `Uploading JSON file: ${config.app.jsonPath}`);
        
        // PLAYWRIGHT ADVANTAGE: setInputFiles is more reliable than uploadFile
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(config.app.jsonPath);
        utils.log(step, 'JSON file uploaded');
        
        // Look for confirmation/import button
        const confirmSelectors = [
            'button:has-text("Import")',
            'button:has-text("Upload")',
            'button:has-text("Continue")',
            'button[type="submit"]'
        ];
        
        for (const selector of confirmSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    utils.log(step, `Clicked confirm button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        utils.log(step, 'Waiting for import to complete...');
        
        // Wait for URL to change to editor or back to applications
        try {
            await page.waitForURL(/\/(edit|editor|applications)/, { timeout: 30000 });
            utils.success(step, 'Application imported successfully');
        } catch (e) {
            // Check if we can see the imported app
            const hasApp = await page.locator('[class*="application-card"], [class*="app-card"]').first().isVisible({ timeout: 5000 });
            if (hasApp) {
                utils.success(step, 'Application imported successfully');
            } else {
                utils.log(step, 'Could not verify import, but continuing...');
            }
        }
        
        return true;
        
    } catch (error) {
        utils.error(step, 'Failed to import JSON', error);
        await utils.takeScreenshot(page, 'import-error');
        throw error;
    }
}

// Step 4: Configure datasource
async function configureDatasource(page) {
    const step = 'DATASOURCE';
    utils.log(step, 'Configuring datasource...');
    
    try {
        // Navigate to editor if not already there
        const url = page.url();
        if (!url.includes('/edit') && !url.includes('/editor')) {
            utils.log(step, 'Opening application in editor...');
            
            // Go to applications page
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: config.playwright.timeout
            });
            
            // Click on the first application
            const firstApp = page.locator('[class*="application-card"], [class*="app-card"]').first();
            await firstApp.click();
            
            // Wait for editor to load
            await page.waitForURL(/\/(edit|editor)/, { timeout: 10000 });
        }
        
        utils.log(step, 'Opening datasource panel...');
        
        // Look for datasource tab/button
        const datasourceSelectors = [
            'button:has-text("Datasources")',
            'button:has-text("Data")',
            'text=Datasources',
            '[data-testid="t--datasource-tab"]'
        ];
        
        for (const selector of datasourceSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    utils.log(step, `Clicked datasource tab: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        // Find and click on the datasource to configure
        utils.log(step, `Looking for datasource: ${config.datasource.name}`);
        
        const datasource = page.locator(`text=${config.datasource.name}`).first();
        if (await datasource.isVisible({ timeout: 5000 })) {
            await datasource.click();
            utils.log(step, 'Opened datasource configuration');
        } else {
            throw new Error(`Could not find datasource: ${config.datasource.name}`);
        }
        
        // Update the URL field
        utils.log(step, 'Updating datasource URL...');
        
        const urlInputSelectors = [
            'input[placeholder*="URL" i]',
            'input[name*="url" i]',
            'input[type="url"]',
            'input[placeholder*="host" i]'
        ];
        
        for (const selector of urlInputSelectors) {
            try {
                const input = page.locator(selector).first();
                if (await input.isVisible({ timeout: 3000 })) {
                    // Clear and fill - Playwright handles this cleanly
                    await input.fill(config.datasource.url);
                    utils.log(step, `URL updated to: ${config.datasource.url}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        // Test the connection
        utils.log(step, 'Testing datasource connection...');
        
        const testButton = page.locator('button:has-text("Test"), button:has-text("Test Connection")').first();
        if (await testButton.isVisible({ timeout: 5000 })) {
            await testButton.click();
            utils.log(step, 'Connection test initiated');
            
            // Wait for test to complete (look for success/failure message)
            await page.waitForTimeout(3000);
        }
        
        // Save the datasource
        utils.log(step, 'Saving datasource...');
        
        const saveButton = page.locator('button:has-text("Save"), button:has-text("Save Changes")').first();
        if (await saveButton.isVisible({ timeout: 5000 })) {
            await saveButton.click();
            utils.log(step, 'Datasource saved');
        }
        
        // Close modal if present
        const closeButton = page.locator('button:has-text("Done"), button:has-text("Close"), [class*="modal-close"]').first();
        if (await closeButton.isVisible({ timeout: 3000 })) {
            await closeButton.click();
            utils.log(step, 'Closed datasource modal');
        }
        
        utils.success(step, 'Datasource configured');
        return true;
        
    } catch (error) {
        utils.error(step, 'Failed to configure datasource', error);
        await utils.takeScreenshot(page, 'datasource-error');
        throw error;
    }
}

// Step 5: Deploy application
async function deployApplication(page) {
    const step = 'DEPLOY';
    utils.log(step, 'Deploying application...');
    
    try {
        // Make sure we're in the editor
        const url = page.url();
        if (!url.includes('/edit') && !url.includes('/editor')) {
            utils.log(step, 'Navigating to editor...');
            
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: config.playwright.timeout
            });
            
            const firstApp = page.locator('[class*="application-card"], [class*="app-card"]').first();
            await firstApp.click();
            
            await page.waitForURL(/\/(edit|editor)/, { timeout: 10000 });
        }
        
        utils.log(step, 'Looking for Deploy button...');
        
        // Find and click deploy button
        const deploySelectors = [
            'button:has-text("Deploy")',
            'button:has-text("Publish")',
            '[data-testid="t--application-publish-btn"]'
        ];
        
        let deployed = false;
        for (const selector of deploySelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    deployed = true;
                    utils.log(step, `Clicked Deploy button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!deployed) {
            throw new Error('Could not find Deploy button');
        }
        
        utils.log(step, 'Waiting for deployment to complete...');
        
        // Wait for success message
        try {
            await page.waitForSelector('text=deployed successfully, text=published successfully, text=Application is live', { 
                timeout: 30000 
            });
            utils.success(step, 'Application deployed successfully!');
        } catch (e) {
            // Check if we can see any error messages
            const hasError = await page.locator('text=error, text=failed').first().isVisible({ timeout: 2000 });
            if (hasError) {
                throw new Error('Deployment failed - error message detected');
            }
            utils.log(step, 'Could not verify deployment message, but no errors detected');
        }
        
        return true;
        
    } catch (error) {
        utils.error(step, 'Failed to deploy application', error);
        await utils.takeScreenshot(page, 'deploy-error');
        throw error;
    }
}

// Main execution
async function main() {
    console.log('╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                   ║');
    console.log('║        Appsmith Full Automation - Playwright Version             ║');
    console.log('║           (Superior reliability and debugging)                   ║');
    console.log('║                                                                   ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
    
    // Validate configuration
    validateConfig();
    
    utils.log('CONFIG', 'Configuration:');
    utils.log('CONFIG', `  Appsmith URL:  ${config.appsmithUrl}`);
    utils.log('CONFIG', `  Admin Email:   ${config.admin.email}`);
    utils.log('CONFIG', `  JSON File:     ${config.app.jsonPath}`);
    utils.log('CONFIG', `  Datasource:    ${config.datasource.url}`);
    utils.log('CONFIG', `  Headless:      ${config.playwright.headless}`);
    utils.log('CONFIG', `  Trace:         ${config.playwright.recordTrace}\n`);
    
    let browser;
    let context;
    let success = false;
    const traceFile = '/tmp/appsmith-automation-trace.zip';
    
    try {
        // Launch browser
        utils.log('BROWSER', 'Launching Chromium...');
        browser = await chromium.launch({
            headless: config.playwright.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        
        // Create context with viewport
        context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        // Set default timeout
        context.setDefaultTimeout(config.playwright.timeout);
        
        // Start tracing for debugging (records screenshots, snapshots, etc.)
        if (config.playwright.recordTrace) {
            await context.tracing.start({ 
                screenshots: true, 
                snapshots: true,
                sources: true
            });
            utils.log('TRACE', 'Recording trace for debugging');
        }
        
        const page = await context.newPage();
        
        utils.success('BROWSER', 'Browser launched');
        
        // Execute automation steps
        await waitForAppsmith(page);
        await createAdminAccount(page);
        await importFromJson(page);
        await configureDatasource(page);
        await deployApplication(page);
        
        success = true;
        
        console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║                                                                   ║');
        console.log('║              ✅ AUTOMATION COMPLETED SUCCESSFULLY!                ║');
        console.log('║                                                                   ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
        
        utils.log('SUCCESS', `Application URL: ${config.appsmithUrl}`);
        utils.log('SUCCESS', `Admin Email: ${config.admin.email}`);
        utils.log('SUCCESS', `Admin Password: ${config.admin.password}`);
        
    } catch (error) {
        utils.error('MAIN', 'Automation failed', error);
        console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║                                                                   ║');
        console.log('║                      ❌ AUTOMATION FAILED                         ║');
        console.log('║                                                                   ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
    } finally {
        // Save trace on failure or if explicitly enabled
        if (context && config.playwright.recordTrace && (!success || process.env.ALWAYS_SAVE_TRACE === 'true')) {
            await context.tracing.stop({ path: traceFile });
            utils.log('TRACE', `Trace saved to ${traceFile}`);
            utils.log('TRACE', `View with: npx playwright show-trace ${traceFile}`);
        }
        
        if (browser) {
            if (config.playwright.headless && !success) {
                utils.log('BROWSER', 'Automation failed - keeping browser open for 5 minutes for debugging...');
                utils.log('BROWSER', 'Press Ctrl+C to close');
                await utils.sleep(300000);
            }
            await browser.close();
            utils.log('BROWSER', 'Browser closed');
        }
    }
    
    process.exit(success ? 0 : 1);
}

// Run the automation
if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { main };
