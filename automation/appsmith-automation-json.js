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
 *   npm install
 *   npx playwright install chromium
 *   node appsmith-automation-json.js
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

// Step 2: Create admin account
async function createAdminAccount(page) {
    const step = 'CREATE_ADMIN';
    utils.log(step, 'Creating admin account...');
    
    try {
        // Navigate to root and check initial state
        utils.log(step, 'Checking Appsmith initial state...');
        
        await page.goto(config.appsmithUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        
        const currentUrl = page.url();
        utils.log(step, `Current URL: ${currentUrl}`);
        
        // Check if admin already exists
        if (currentUrl.includes('/user/login')) {
            utils.log(step, 'Admin account exists, attempting login...');
            
            try {
                await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });
                await page.fill('input[type="email"], input[name="email"]', config.admin.email);
                await page.fill('input[type="password"]', config.admin.password);
                
                utils.log(step, 'Login credentials entered');
                
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
        
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
        
// Fill name fields
utils.log(step, 'Filling name fields...');

// Wait for form to be ready
await page.waitForSelector('input[type="email"]', { timeout: 10000 });
await page.waitForTimeout(1000);

// First name - use getByLabel (most reliable for Appsmith forms)
try {
    // Try by label text first
    const firstNameInput = page.getByLabel(/first name/i).first();
    await firstNameInput.click();
    await firstNameInput.fill('NetSwift');
    await page.waitForTimeout(500);
    
    // Verify it was filled
    const value = await firstNameInput.inputValue();
    if (value === 'NetSwift') {
        utils.log(step, 'First name entered: NetSwift');
    } else {
        throw new Error('First name not filled');
    }
} catch (e) {
    // Fallback: try by placeholder
    try {
        const firstNameInput = page.getByPlaceholder(/john/i).first();
        await firstNameInput.click();
        await firstNameInput.fill('NetSwift');
        await page.waitForTimeout(500);
        utils.log(step, 'First name entered: NetSwift (via placeholder)');
    } catch (e2) {
        utils.log(step, `First name field error: ${e2.message}`);
    }
}

// Last name
try {
    const lastNameInput = page.getByLabel(/last name/i).first();
    await lastNameInput.click();
    await lastNameInput.fill('Admin');
    await page.waitForTimeout(500);
    utils.log(step, 'Last name entered: Admin');
} catch (e) {
    try {
        // Fallback to name attribute
        await page.fill('input[name="lastName"]', 'Admin');
        utils.log(step, 'Last name entered: Admin (via name attr)');
    } catch (e2) {
        utils.log(step, 'Last name might not be required');
    }
}
        
        // Fill email
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
        
        if (passwordFields.length > 1) {
            await passwordFields[1].fill(config.admin.password);
            utils.log(step, 'Verify password entered');
        }
        
        await utils.takeScreenshot(page, 'before-signup-submit');
        
        utils.log(step, 'Form filled, submitting...');
        
        // Submit the form
        const submitSelectors = [
            'button:has-text("Continue")',
            'button:has-text("Sign Up")',
            'button:has-text("Get Started")',
            'button:has-text("Create Account")',
            'button[type="submit"]'
        ];
        
// Submit the form
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

// CRITICAL: Wait for navigation to actually start
await page.waitForTimeout(3000);

// Now wait for URL to change or onboarding to appear
try {
    await Promise.race([
        page.waitForURL(url => 
            !url.includes('/setup/welcome') && !url.includes('/user/signup'),
            { timeout: 20000 }
        ),
        page.waitForSelector('text=What is your general development proficiency', { timeout: 20000 })
    ]);
    
    utils.log(step, 'Signup completed - page transitioned');
        
        // Wait for URL to change or onboarding to appear
        try {
            await Promise.race([
                page.waitForURL(url => 
                    !url.includes('/setup/welcome') && !url.includes('/user/signup'),
                    { timeout: 20000 }
                ),
                page.waitForSelector('text=Novice, text=Expert, text=Personal Project', { timeout: 20000 })
            ]);
            
            utils.log(step, 'Signup completed - page transitioned');
            
        } catch (timeoutError) {
            utils.log(step, 'Timeout waiting for signup - checking current state...');
            await utils.takeScreenshot(page, 'signup-timeout');
            
            const currentUrl = page.url();
            utils.log(step, `Current URL after timeout: ${currentUrl}`);
            
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
    // Wait for onboarding page to appear
    await page.waitForSelector('text=What is your general development proficiency', { timeout: 5000 });
    
    // Question 1: Development proficiency - select "Novice"
    await page.click('button:has-text("Novice"), div[role="button"]:has-text("Novice")');
    utils.log(step, 'Selected: Novice');
    await page.waitForTimeout(1000);
    
    // Question 2: Use case - select "Personal Project"
    await page.click('button:has-text("Personal Project"), div[role="button"]:has-text("Personal Project")');
    utils.log(step, 'Selected: Personal Project');
    await page.waitForTimeout(1000);
    
    // Leave checkbox as-is (checked by default is fine)
    utils.log(step, 'Left checkbox as default');
    await page.waitForTimeout(1000);
    
    // Click "Get started" button
    await page.click('button:has-text("Get started")');
    utils.log(step, 'Clicked Get started button');
    
} catch (e) {
    utils.log(step, 'Onboarding questions not found or already completed');
}

// Handle onboarding questions
utils.log(step, 'Handling onboarding questions...');

try {
    // Wait for onboarding page to appear
    await page.waitForSelector('text=What is your general development proficiency', { timeout: 5000 });
    
    // Question 1: Development proficiency - select "Novice"
    await page.click('button:has-text("Novice"), div[role="button"]:has-text("Novice")');
    utils.log(step, 'Selected: Novice');
    await page.waitForTimeout(1000);
    
    // Question 2: Use case - select "Personal Project"
    await page.click('button:has-text("Personal Project"), div[role="button"]:has-text("Personal Project")');
    utils.log(step, 'Selected: Personal Project');
    await page.waitForTimeout(1000);
    
    // Leave checkbox as-is (checked by default is fine)
    utils.log(step, 'Left checkbox as default');
    await page.waitForTimeout(1000);
    
    // Click "Get started" button
    await page.click('button:has-text("Get started")');
    utils.log(step, 'Clicked Get started button');
    
} catch (e) {
    utils.log(step, 'Onboarding questions not found or already completed');
}

// Wait for redirect to applications page OR login page
utils.log(step, 'Waiting for redirect...');

try {
    await Promise.race([
        page.waitForURL(/\/(applications|home|workspace)/, { timeout: 20000 }),
        page.waitForURL(/\/user\/login/, { timeout: 20000 })
    ]);
    
    const currentUrl = page.url();
    utils.log(step, `Redirected to: ${currentUrl}`);
    
    // If on login page, login with the credentials
    if (currentUrl.includes('/user/login')) {
        utils.log(step, 'On login page, logging in...');
        
        await page.fill('input[type="email"]', config.admin.email);
        await page.fill('input[type="password"]', config.admin.password);
        await page.click('button[type="submit"], button:has-text("Login")');
        
        await page.waitForURL(/\/(applications|home|workspace)/, { timeout: 15000 });
        utils.log(step, 'Logged in successfully');
    }
    
} catch (timeoutError) {
    utils.log(step, 'Timeout waiting for redirect - checking current state...');
    await utils.takeScreenshot(page, 'signup-timeout');
    
    const currentUrl = page.url();
    utils.log(step, `Current URL after timeout: ${currentUrl}`);
    
    if (currentUrl.includes('/setup/welcome') || currentUrl.includes('/user/signup')) {
        throw new Error('Signup FAILED - still on signup page after submission');
    }
}

const finalUrl = page.url();
utils.log(step, `Final URL: ${finalUrl}`);
await utils.takeScreenshot(page, 'signup-final-state');

// Verify we're not still on signup page
if (finalUrl.includes('/setup/welcome') || finalUrl.includes('/user/signup')) {
    throw new Error('Signup FAILED - still on signup page! Admin account was not created.');
}

if (finalUrl.includes('/applications') || 
    finalUrl.includes('/home') || 
    finalUrl.includes('/workspace')) {
    utils.success(step, `Admin account created: ${config.admin.email}`);
    return true;
}

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
        const currentUrl = page.url();
        if (!currentUrl.includes('/applications') && !currentUrl.includes('/home')) {
            utils.log(step, 'Navigating to applications page...');
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: config.playwright.timeout
            });
        }
        
        utils.log(step, 'Looking for import option...');
        
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
        
        utils.log(step, `Uploading JSON file: ${config.app.jsonPath}`);
        
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(config.app.jsonPath);
        utils.log(step, 'JSON file uploaded');
        
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
        
        try {
            await page.waitForURL(/\/(edit|editor|applications)/, { timeout: 30000 });
            utils.success(step, 'Application imported successfully');
        } catch (e) {
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
        const url = page.url();
        if (!url.includes('/edit') && !url.includes('/editor')) {
            utils.log(step, 'Opening application in editor...');
            
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: config.playwright.timeout
            });
            
            const firstApp = page.locator('[class*="application-card"], [class*="app-card"]').first();
            await firstApp.click();
            
            await page.waitForURL(/\/(edit|editor)/, { timeout: 10000 });
        }
        
        utils.log(step, 'Opening datasource panel...');
        
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
        
        utils.log(step, `Looking for datasource: ${config.datasource.name}`);
        
        const datasource = page.locator(`text=${config.datasource.name}`).first();
        if (await datasource.isVisible({ timeout: 5000 })) {
            await datasource.click();
            utils.log(step, 'Opened datasource configuration');
        } else {
            throw new Error(`Could not find datasource: ${config.datasource.name}`);
        }
        
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
                    await input.fill(config.datasource.url);
                    utils.log(step, `URL updated to: ${config.datasource.url}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        utils.log(step, 'Testing datasource connection...');
        
        const testButton = page.locator('button:has-text("Test"), button:has-text("Test Connection")').first();
        if (await testButton.isVisible({ timeout: 5000 })) {
            await testButton.click();
            utils.log(step, 'Connection test initiated');
            await page.waitForTimeout(3000);
        }
        
        utils.log(step, 'Saving datasource...');
        
        const saveButton = page.locator('button:has-text("Save"), button:has-text("Save Changes")').first();
        if (await saveButton.isVisible({ timeout: 5000 })) {
            await saveButton.click();
            utils.log(step, 'Datasource saved');
        }
        
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
        
        try {
            await page.waitForSelector('text=deployed successfully, text=published successfully, text=Application is live', { 
                timeout: 30000 
            });
            utils.success(step, 'Application deployed successfully!');
        } catch (e) {
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
    console.log('║                                                                   ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
    
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
        utils.log('BROWSER', 'Launching Chromium...');
        browser = await chromium.launch({
            headless: config.playwright.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        
        context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        context.setDefaultTimeout(config.playwright.timeout);
        
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
        if (context && config.playwright.recordTrace && (!success || process.env.ALWAYS_SAVE_TRACE === 'true')) {
            await context.tracing.stop({ path: traceFile });
            utils.log('TRACE', `Trace saved to ${traceFile}`);
            utils.log('TRACE', `View with: npx playwright show-trace ${traceFile}`);
        }
        
        if (browser) {
            if (config.playwright.headless && !success) {
                utils.log('BROWSER', 'Automation failed - keeping browser open for 5 minutes...');
                utils.log('BROWSER', 'Press Ctrl+C to close');
                await utils.sleep(300000);
            }
            await browser.close();
            utils.log('BROWSER', 'Browser closed');
        }
    }
    
    process.exit(success ? 0 : 1);
}

if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { main };
