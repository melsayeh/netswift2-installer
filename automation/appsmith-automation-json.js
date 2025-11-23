#!/usr/bin/env node
/**
 * Appsmith Full Automation Script - Consolidated Playwright Version
 * Version: 7.2.1
 * 
 * This script uses Playwright to automate the Appsmith web UI:
 * 1. Create admin account with detailed onboarding flow
 * 2. Import application from JSON file (includes datasource config)
 * 3. Detect actual NetSwift URL (login page ID is dynamic)
 * 4. Display access instructions with correct URL to user
 * 
 * Changes in v7.2.1:
 * - Added handling for "Reconnect datasources" modal when opening app
 * - Clicks "Go to application" or "Skip configuration" to bypass
 * 
 * Changes in v7.2.0:
 * - Added dynamic URL detection for NetSwift login page
 * - Opens imported app and detects the actual login page URL
 * - Displays correct URL with dynamic page ID to user
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
        firstName: process.env.ADMIN_FIRSTNAME || 'NetSwift',
        lastName: process.env.ADMIN_LASTNAME || 'Admin',
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
        recordTrace: process.env.RECORD_TRACE !== 'false',
        slowMo: parseInt(process.env.SLOWMO || '0')
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

// Step 2: Create admin account with improved selectors from recording
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
            return await loginExistingAdmin(page);
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
                
                // Wait a moment for page to stabilize
                await page.waitForTimeout(2000);
                
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
        
        // Wait for form to be ready
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.waitForTimeout(1000);
        
        // Split full name for firstName/lastName fields
        const nameParts = config.admin.name.split(' ');
        const firstName = config.admin.firstName || nameParts[0] || 'NetSwift';
        const lastName = config.admin.lastName || nameParts.slice(1).join(' ') || 'Admin';
        
        // Fill form using data-testid attributes (from recording)
        utils.log(step, 'Filling first name...');
        try {
            const firstNameSelector = '[data-testid="firstName"]';
            const firstNameInput = page.locator(firstNameSelector).first();
            if (await firstNameInput.isVisible({ timeout: 3000 })) {
                await firstNameInput.click();
                await firstNameInput.fill(firstName);
                utils.log(step, `First name: ${firstName}`);
            } else {
                // Fallback to label-based selection
                const input = page.getByLabel(/first name/i).first();
                await input.click();
                await input.fill(firstName);
                utils.log(step, `First name (fallback): ${firstName}`);
            }
        } catch (e) {
            utils.log(step, 'Using fallback for first name');
            await page.fill('input[name="firstName"], input[placeholder*="first" i]', firstName);
        }
        
        utils.log(step, 'Filling last name...');
        try {
            const lastNameSelector = '[data-testid="lastName"]';
            const lastNameInput = page.locator(lastNameSelector).first();
            if (await lastNameInput.isVisible({ timeout: 3000 })) {
                await lastNameInput.click();
                await lastNameInput.fill(lastName);
                utils.log(step, `Last name: ${lastName}`);
            } else {
                // Fallback to label-based selection
                const input = page.getByLabel(/last name/i).first();
                await input.click();
                await input.fill(lastName);
                utils.log(step, `Last name (fallback): ${lastName}`);
            }
        } catch (e) {
            utils.log(step, 'Using fallback for last name');
            await page.fill('input[name="lastName"], input[placeholder*="last" i]', lastName);
        }
        
        utils.log(step, 'Filling email...');
        try {
            const emailSelector = '[data-testid="email"]';
            const emailInput = page.locator(emailSelector).first();
            if (await emailInput.isVisible({ timeout: 3000 })) {
                await emailInput.click();
                await emailInput.fill(config.admin.email);
                utils.log(step, `Email: ${config.admin.email}`);
            } else {
                await page.fill('input[type="email"]', config.admin.email);
                utils.log(step, `Email (fallback): ${config.admin.email}`);
            }
        } catch (e) {
            await page.fill('input[type="email"]', config.admin.email);
        }
        
        utils.log(step, 'Filling password...');
        try {
            const passwordSelector = '[data-testid="password"]';
            const passwordInput = page.locator(passwordSelector).first();
            if (await passwordInput.isVisible({ timeout: 3000 })) {
                await passwordInput.click();
                await passwordInput.fill(config.admin.password);
                utils.log(step, 'Password entered');
            } else {
                const inputs = await page.locator('input[type="password"]').all();
                if (inputs.length > 0) {
                    await inputs[0].click();
                    await inputs[0].fill(config.admin.password);
                    utils.log(step, 'Password entered (fallback)');
                }
            }
        } catch (e) {
            const inputs = await page.locator('input[type="password"]').all();
            if (inputs.length > 0) {
                await inputs[0].fill(config.admin.password);
            }
        }
        
        utils.log(step, 'Filling password confirmation...');
        try {
            const verifyPasswordSelector = '[data-testid="verifyPassword"]';
            const verifyPasswordInput = page.locator(verifyPasswordSelector).first();
            if (await verifyPasswordInput.isVisible({ timeout: 3000 })) {
                await verifyPasswordInput.click();
                await verifyPasswordInput.fill(config.admin.password);
                utils.log(step, 'Password confirmation entered');
            } else {
                const inputs = await page.locator('input[type="password"]').all();
                if (inputs.length > 1) {
                    await inputs[1].click();
                    await inputs[1].fill(config.admin.password);
                    utils.log(step, 'Password confirmation entered (fallback)');
                }
            }
        } catch (e) {
            const inputs = await page.locator('input[type="password"]').all();
            if (inputs.length > 1) {
                await inputs[1].fill(config.admin.password);
            }
        }
        
        await page.waitForTimeout(1000);
        await utils.takeScreenshot(page, 'signup-form-filled');
        
        // Submit signup form - try "Continue" button first (from recording)
        utils.log(step, 'Submitting signup form...');
        
        const submitSelectors = [
            'text=Continue',
            'button:has-text("Continue")',
            'button:has-text("Sign up")',
            'button:has-text("Get started")',
            'button[type="submit"]'
        ];
        
        let submitted = false;
        for (const selector of submitSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 3000 })) {
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
            throw new Error('Could not find submit button');
        }
        
        // Wait for onboarding questions page
        await page.waitForTimeout(3000);
        
        // Handle onboarding questions (from recording)
        try {
            utils.log(step, 'Handling onboarding questions...');
            
            // Question 1: Development proficiency - select "Novice"
            // Using the selector from recording
            const noviceSelectors = [
                '.sc-jPNehe:nth-child(1) .sc-hLBbgP:nth-child(2) > .sc-dkrFOg',
                'div:has-text("Novice")',
                'button:has-text("Novice")',
                '[role="button"]:has-text("Novice")'
            ];
            
            let noviceClicked = false;
            for (const selector of noviceSelectors) {
                try {
                    const button = page.locator(selector).first();
                    if (await button.isVisible({ timeout: 3000 })) {
                        await button.click();
                        noviceClicked = true;
                        utils.log(step, 'Selected: Novice');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!noviceClicked) {
                utils.log(step, 'Could not select Novice option');
            }
            
            await page.waitForTimeout(1000);
            
            // Question 2: Use case - select "Personal Project"
            const personalProjectSelectors = [
                '.sc-jPNehe:nth-child(3) .sc-hLBbgP:nth-child(2) > .sc-dkrFOg',
                'div:has-text("Personal Project")',
                'button:has-text("Personal Project")',
                '[role="button"]:has-text("Personal Project")'
            ];
            
            let projectClicked = false;
            for (const selector of personalProjectSelectors) {
                try {
                    const button = page.locator(selector).first();
                    if (await button.isVisible({ timeout: 3000 })) {
                        await button.click();
                        projectClicked = true;
                        utils.log(step, 'Selected: Personal Project');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!projectClicked) {
                utils.log(step, 'Could not select Personal Project option');
            }
            
            await page.waitForTimeout(1000);
            
            // Handle checkbox if needed (from recording: .ads-v2-checkbox__square)
            try {
                const checkboxSelectors = [
                    '.ads-v2-checkbox__square',
                    'input[type="checkbox"]',
                    '[role="checkbox"]'
                ];
                
                for (const selector of checkboxSelectors) {
                    const checkbox = page.locator(selector).first();
                    if (await checkbox.isVisible({ timeout: 2000 })) {
                        // Check if already checked
                        const isChecked = await checkbox.isChecked().catch(() => false);
                        if (!isChecked) {
                            await checkbox.click();
                            utils.log(step, 'Checked terms checkbox');
                        } else {
                            utils.log(step, 'Checkbox already checked');
                        }
                        break;
                    }
                }
            } catch (e) {
                utils.log(step, 'Checkbox handling skipped');
            }
            
            await page.waitForTimeout(1000);
            
            // Click "Get started" button (from recording: .gqvXeY > .sc-dkrFOg)
            const getStartedSelectors = [
                '.gqvXeY > .sc-dkrFOg',
                'div:has-text("Get started")',
                'button:has-text("Get started")',
                'text=Get started'
            ];
            
            let getStartedClicked = false;
            for (const selector of getStartedSelectors) {
                try {
                    const button = page.locator(selector).first();
                    if (await button.isVisible({ timeout: 3000 })) {
                        await button.click();
                        getStartedClicked = true;
                        utils.log(step, 'Clicked Get started button');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!getStartedClicked) {
                utils.log(step, 'Could not click Get started button');
            }
            
        } catch (e) {
            utils.log(step, 'Onboarding questions not found or already completed');
        }
        
        // Wait for redirect (may go to login page or directly to app)
        utils.log(step, 'Waiting for redirect after onboarding...');
        
        await page.waitForTimeout(3000);
        
        try {
            await Promise.race([
                page.waitForURL(/\/(applications|home|workspace)/, { timeout: 20000 }),
                page.waitForURL(/\/user\/login/, { timeout: 20000 })
            ]);
            
            const currentUrl = page.url();
            utils.log(step, `Redirected to: ${currentUrl}`);
            
            // If redirected to login page, perform login
            if (currentUrl.includes('/user/login')) {
                utils.log(step, 'Redirected to login page, logging in...');
                return await loginExistingAdmin(page);
            }
            
        } catch (timeoutError) {
            utils.log(step, 'Timeout waiting for redirect - checking current state...');
            await utils.takeScreenshot(page, 'signup-timeout');
            
            const currentUrl = page.url();
            utils.log(step, `Current URL after timeout: ${currentUrl}`);
            
            if (currentUrl.includes('/user/login')) {
                utils.log(step, 'On login page, attempting login...');
                return await loginExistingAdmin(page);
            }
            
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
        
        // After signup completes, user is already logged in
        // Just verify we're on the right page and proceed
        if (finalUrl.includes('/applications') || 
            finalUrl.includes('/home') || 
            finalUrl.includes('/workspace')) {
            utils.success(step, `Admin account created and logged in: ${config.admin.email}`);
            
            // Navigate to applications page to ensure we're in the right place for import
            utils.log(step, 'Navigating to applications page...');
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            // Wait for page to fully load
            await page.waitForTimeout(3000);
            
            return true;
        }
        
        try {
            await page.waitForSelector('.workspace, [class*="workspace"], [class*="home"], [class*="application"]', { 
                timeout: 10000 
            });
            
            utils.success(step, `Admin account created and logged in: ${config.admin.email}`);
            
            // Navigate to applications page
            utils.log(step, 'Navigating to applications page...');
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            await page.waitForTimeout(3000);
            
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

// Helper: Login with existing admin account (from recording)
async function loginExistingAdmin(page) {
    const step = 'LOGIN';
    utils.log(step, 'Logging in with existing admin account...');
    
    try {
        // Navigate to login page if not already there
        const currentUrl = page.url();
        if (!currentUrl.includes('/user/login')) {
            await page.goto(`${config.appsmithUrl}/user/login`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
        }
        
        await page.waitForTimeout(2000);
        
        utils.log(step, 'Filling login credentials...');
        
        // Fill email - try different selectors
        try {
            await page.fill('input[type="email"]', config.admin.email);
            utils.log(step, `Email filled: ${config.admin.email}`);
        } catch (e) {
            const emailInput = page.locator('input[name="email"]').first();
            await emailInput.fill(config.admin.email);
        }
        
        await page.waitForTimeout(500);
        
        // Fill password
        try {
            await page.fill('input[type="password"]', config.admin.password);
            utils.log(step, 'Password filled');
        } catch (e) {
            const passwordInput = page.locator('input[name="password"]').first();
            await passwordInput.fill(config.admin.password);
        }
        
        await page.waitForTimeout(1000);
        await utils.takeScreenshot(page, 'login-form-filled');
        
        // Submit login form - from recording: .sc-dkrFOg or button with "Sign in"
        utils.log(step, 'Submitting login form...');
        
        const loginButtonSelectors = [
            '.sc-dkrFOg',
            'div:has-text("Sign in")',
            'button:has-text("Sign in")',
            'button:has-text("Login")',
            'button[type="submit"]'
        ];
        
        let loginClicked = false;
        for (const selector of loginButtonSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 3000 })) {
                    await Promise.all([
                        button.click(),
                        page.waitForNavigation({ timeout: 15000 }).catch(() => {})
                    ]);
                    loginClicked = true;
                    utils.log(step, `Clicked login button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!loginClicked) {
            throw new Error('Could not find login button');
        }
        
        // Wait for redirect to applications page
        await page.waitForTimeout(3000);
        
        try {
            await page.waitForURL(/\/(applications|home|workspace)/, { timeout: 15000 });
            utils.success(step, 'Logged in successfully');
            return true;
        } catch (e) {
            const currentUrl = page.url();
            if (currentUrl.includes('/applications') || currentUrl.includes('/home')) {
                utils.success(step, 'Logged in successfully');
                return true;
            }
            throw new Error('Login failed - not redirected to applications page');
        }
        
    } catch (error) {
        utils.error(step, 'Login failed', error);
        await utils.takeScreenshot(page, 'login-error');
        throw error;
    }
}

// Step 3: Import application from JSON file (from recording)
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
        
        // Wait longer for page to fully load after login
        utils.log(step, 'Waiting for page to fully load...');
        await page.waitForTimeout(5000);
        
        // Wait for network idle
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
            utils.log(step, 'Network idle timeout, continuing...');
        });
        
        utils.log(step, 'Looking for Create new button or menu...');
        await utils.takeScreenshot(page, 'before-clicking-menu');
        
        // CRITICAL: Import option is inside "Create new" dropdown menu
        // First, click on "Create new" button to reveal the Import option
        const menuSelectors = [
            'button:has-text("Create new")',
            '[class*="create-new"]',
            'button:has-text("New")',
            '[data-testid*="create-new"]',
            // Three-dot menu as alternative
            'button[class*="more"]',
            '[aria-label*="more" i]',
            'button[aria-haspopup="menu"]'
        ];
        
        let menuOpened = false;
        for (const selector of menuSelectors) {
            try {
                utils.log(step, `Trying menu button: ${selector}`);
                const button = page.locator(selector).first();
                
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    menuOpened = true;
                    utils.log(step, `✓ Opened dropdown menu: ${selector}`);
                    await page.waitForTimeout(1500); // Wait for dropdown animation
                    break;
                }
            } catch (e) {
                utils.log(step, `Menu button ${selector} not found, trying next...`);
                continue;
            }
        }
        
        if (!menuOpened) {
            utils.log(step, 'Warning: Could not find menu button, trying direct import...');
        }
        
        await utils.takeScreenshot(page, 'after-menu-click');
        utils.log(step, 'Looking for Import option in menu...');
        
        // From recording: [data-testid="t--workspace-import-app"]
        const importSelectors = [
            '[data-testid="t--workspace-import-app"]',
            '[role="menuitem"]:has-text("Import")',
            'div:has-text("Import")',
            'button:has-text("Import")',
            'a:has-text("Import")',
            'text=Import',
            '[data-testid*="import"]',
            '[class*="import"]'
        ];
        
        let importClicked = false;
        for (const selector of importSelectors) {
            try {
                utils.log(step, `Trying import selector: ${selector}`);
                const button = page.locator(selector).first();
                
                // Wait longer for element to appear
                const isVisible = await button.isVisible({ timeout: 10000 });
                if (isVisible) {
                    await button.click();
                    importClicked = true;
                    utils.log(step, `✓ Clicked import button: ${selector}`);
                    break;
                }
            } catch (e) {
                utils.log(step, `Selector ${selector} not found, trying next...`);
                continue;
            }
        }
        
        if (!importClicked) {
            await utils.takeScreenshot(page, 'import-option-not-found-in-menu');
            throw new Error('Could not find Import option in Create new menu');
        }
        
        await page.waitForTimeout(2000);
        
        // After clicking Import, a modal appears with 2 options:
        // 1. "Import from a Git repo"
        // 2. "Import from file"
        // We need to click "Import from file"
        utils.log(step, 'Looking for "Import from file" option...');
        await utils.takeScreenshot(page, 'import-modal-with-options');
        
        // From recording: .button-wrapper
        const importFromFileSelectors = [
            '.button-wrapper',
            'div:has-text("Import from file")',
            'button:has-text("Import from file")',
            'text=Import from file',
            '[data-testid*="import-from-file"]'
        ];
        
        let importFromFileClicked = false;
        for (const selector of importFromFileSelectors) {
            try {
                utils.log(step, `Trying "Import from file" selector: ${selector}`);
                const button = page.locator(selector).first();
                
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    importFromFileClicked = true;
                    utils.log(step, `✓ Clicked "Import from file": ${selector}`);
                    break;
                }
            } catch (e) {
                utils.log(step, `Selector ${selector} not found, trying next...`);
                continue;
            }
        }
        
        if (!importFromFileClicked) {
            await utils.takeScreenshot(page, 'import-from-file-not-found');
            throw new Error('Could not find "Import from file" option in import modal');
        }
        
        await page.waitForTimeout(1000);
        
        utils.log(step, `Uploading JSON file: ${config.app.jsonPath}`);
        
        // From recording: #fileInput
        const fileInputSelectors = [
            '#fileInput',
            'input[type="file"]'
        ];
        
        let fileUploaded = false;
        for (const selector of fileInputSelectors) {
            try {
                const fileInput = page.locator(selector).first();
                await fileInput.setInputFiles(config.app.jsonPath);
                fileUploaded = true;
                utils.log(step, 'JSON file uploaded');
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!fileUploaded) {
            throw new Error('Could not upload JSON file');
        }
        
        await page.waitForTimeout(2000);
        
        // Wait for upload to complete and modal to appear
        utils.log(step, 'Waiting for import to process...');
        
        // Click close/dismiss button if modal appears
        // From recording: .sc-eJKXev .remixicon-icon (close icon)
        try {
            const closeSelectors = [
                '.sc-eJKXev .remixicon-icon',
                'button:has-text("Close")',
                'button:has-text("Done")',
                '[aria-label="Close"]',
                '.modal-close'
            ];
            
            await page.waitForTimeout(3000);
            
            for (const selector of closeSelectors) {
                const closeButton = page.locator(selector).first();
                if (await closeButton.isVisible({ timeout: 5000 })) {
                    await closeButton.click();
                    utils.log(step, 'Closed import modal');
                    break;
                }
            }
        } catch (e) {
            utils.log(step, 'No modal to close or already closed');
        }
        
        await page.waitForTimeout(2000);
        
        utils.log(step, 'Verifying import...');
        
        try {
            // Check if we're on editor page or if app card is visible
            await Promise.race([
                page.waitForURL(/\/(edit|editor)/, { timeout: 15000 }),
                page.locator('[class*="application-card"], [class*="app-card"]').first().waitFor({ timeout: 15000 })
            ]);
            utils.success(step, 'Application imported successfully');
        } catch (e) {
            const hasApp = await page.locator('[class*="application-card"], [class*="app-card"]').first().isVisible({ timeout: 5000 });
            if (hasApp) {
                utils.success(step, 'Application imported successfully');
            } else {
                utils.log(step, 'Could not verify import completely, but continuing...');
            }
        }
        
        await utils.takeScreenshot(page, 'import-complete');
        return true;
        
    } catch (error) {
        utils.error(step, 'Failed to import JSON', error);
        await utils.takeScreenshot(page, 'import-error');
        throw error;
    }
}

// Step 4: Get NetSwift application URL (detect dynamic login page ID)
async function getNetSwiftUrl(page) {
    const step = 'GET_URL';
    utils.log(step, 'Detecting NetSwift application URL...');
    
    try {
        // Navigate to applications page if not already there
        const currentUrl = page.url();
        if (!currentUrl.includes('/applications')) {
            utils.log(step, 'Navigating to applications page...');
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            await page.waitForTimeout(3000);
        }
        
        utils.log(step, 'Looking for NetSwift application...');
        
        // Look for the NetSwift app card (should be the most recently imported)
        const appSelectors = [
            '[class*="application-card"]:has-text("NetSwift")',
            '[class*="application-card"]:has-text("netswift")',
            '[class*="app-card"]:has-text("NetSwift")',
            '[class*="app-card"]:has-text("netswift")',
            // Fallback: get first/most recent app
            '[class*="application-card"]',
            '[class*="app-card"]'
        ];
        
        let appCard = null;
        for (const selector of appSelectors) {
            try {
                const card = page.locator(selector).first();
                if (await card.isVisible({ timeout: 5000 })) {
                    appCard = card;
                    utils.log(step, `Found app with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!appCard) {
            throw new Error('Could not find NetSwift application card');
        }
        
        await utils.takeScreenshot(page, 'before-opening-app');
        
        // Click on the app card to open it
        utils.log(step, 'Opening NetSwift application...');
        await appCard.click();
        
        // Wait for navigation or modal to appear
        await page.waitForTimeout(3000);
        
        // Handle "Reconnect datasources" modal if it appears
        utils.log(step, 'Checking for datasource reconnection modal...');
        
        const skipDatasourceSelectors = [
            'button:has-text("Go to application")',
            'button:has-text("Skip configuration")',
            '[data-testid*="skip"]',
            'text=Go to application',
            'text=Skip configuration'
        ];
        
        let modalHandled = false;
        for (const selector of skipDatasourceSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    modalHandled = true;
                    utils.log(step, `Clicked: ${selector}`);
                    await page.waitForTimeout(2000);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (modalHandled) {
            utils.log(step, 'Datasource modal bypassed');
        } else {
            utils.log(step, 'No datasource modal found, continuing...');
        }
        
        // Wait for navigation to app
        await page.waitForTimeout(3000);
        await page.waitForURL(/\/app\//, { timeout: 30000 });
        
        const appUrl = page.url();
        utils.log(step, `Current URL: ${appUrl}`);
        
        // Extract the page URL (remove /edit or query params)
        let netswiftUrl = appUrl;
        
        // Check if we're already on login page
        if (appUrl.includes('loginpage-')) {
            netswiftUrl = appUrl.replace(/\/edit.*$/, '').split('?')[0];
            utils.log(step, `Already on login page: ${netswiftUrl}`);
        } else {
            // Look for login page in pages sidebar
            utils.log(step, 'Looking for login page in navigation...');
            await page.waitForTimeout(2000);
            
            const loginPageSelectors = [
                'text=loginpage',
                'text=LoginPage',
                'text=Login',
                '[class*="page"]:has-text("login" i)'
            ];
            
            let loginPageFound = false;
            for (const selector of loginPageSelectors) {
                try {
                    const loginLink = page.locator(selector).first();
                    if (await loginLink.isVisible({ timeout: 3000 })) {
                        utils.log(step, `Found login page link: ${selector}`);
                        await loginLink.click();
                        await page.waitForTimeout(2000);
                        await page.waitForURL(/loginpage-/, { timeout: 10000 }).catch(() => {});
                        netswiftUrl = page.url().replace(/\/edit.*$/, '').split('?')[0];
                        loginPageFound = true;
                        utils.log(step, `Navigated to login page: ${netswiftUrl}`);
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!loginPageFound) {
                // Use current app URL as fallback
                netswiftUrl = appUrl.replace(/\/edit.*$/, '').split('?')[0];
                utils.log(step, `Using current page URL: ${netswiftUrl}`);
            }
        }
        
        await utils.takeScreenshot(page, 'netswift-url-detected');
        
        utils.success(step, `NetSwift URL detected: ${netswiftUrl}`);
        return netswiftUrl;
        
    } catch (error) {
        utils.error(step, 'Failed to detect NetSwift URL', error);
        await utils.takeScreenshot(page, 'get-url-error');
        return null;
    }
}

// Step 5: Configure datasource (DEPRECATED - kept for reference)
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
            
            await page.waitForTimeout(2000);
            
            const firstApp = page.locator('[class*="application-card"], [class*="app-card"]').first();
            await firstApp.click();
            
            await page.waitForURL(/\/(edit|editor)/, { timeout: 10000 });
        }
        
        await page.waitForTimeout(2000);
        
        utils.log(step, 'Looking for datasource panel...');
        
        const datasourceSelectors = [
            'text=Datasources',
            '[data-testid="t--datasource"]',
            'button:has-text("Datasources")',
            'a:has-text("Datasources")'
        ];
        
        for (const selector of datasourceSelectors) {
            try {
                const button = page.locator(selector).first();
                if (await button.isVisible({ timeout: 5000 })) {
                    await button.click();
                    utils.log(step, `Clicked datasource panel: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        await page.waitForTimeout(2000);
        
        utils.log(step, 'Looking for datasource to configure...');
        
        const datasourceNameSelectors = [
            `text=${config.datasource.name}`,
            'text=NetSwift',
            'text=Backend',
            '[class*="datasource-card"]',
            '[class*="datasource-item"]'
        ];
        
        let datasourceFound = false;
        for (const selector of datasourceNameSelectors) {
            try {
                const datasource = page.locator(selector).first();
                if (await datasource.isVisible({ timeout: 5000 })) {
                    await datasource.click();
                    datasourceFound = true;
                    utils.log(step, `Found and opened datasource: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!datasourceFound) {
            utils.log(step, 'Datasource not found, may already be configured');
            return true;
        }
        
        await page.waitForTimeout(2000);
        
        utils.log(step, `Configuring datasource URL: ${config.datasource.url}`);
        
        const urlInputSelectors = [
            'input[placeholder*="URL" i]',
            'input[name*="url" i]',
            'input[label*="URL" i]'
        ];
        
        for (const selector of urlInputSelectors) {
            try {
                const input = page.locator(selector).first();
                if (await input.isVisible({ timeout: 5000 })) {
                    await input.clear();
                    await input.fill(config.datasource.url);
                    utils.log(step, 'URL configured');
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        await page.waitForTimeout(1000);
        
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
        
        await page.waitForTimeout(2000);
        
        const closeButton = page.locator('button:has-text("Done"), button:has-text("Close"), [class*="modal-close"]').first();
        if (await closeButton.isVisible({ timeout: 3000 })) {
            await closeButton.click();
            utils.log(step, 'Closed datasource modal');
        }
        
        utils.success(step, 'Datasource configured');
        await utils.takeScreenshot(page, 'datasource-configured');
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
            
            await page.waitForTimeout(2000);
            
            const firstApp = page.locator('[class*="application-card"], [class*="app-card"]').first();
            await firstApp.click();
            
            await page.waitForURL(/\/(edit|editor)/, { timeout: 10000 });
        }
        
        await page.waitForTimeout(2000);
        
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
        
        await page.waitForTimeout(2000);
        await utils.takeScreenshot(page, 'deployment-complete');
        
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
    console.log('║        Appsmith Automation - NetSwift Installer v7.2.1           ║');
    console.log('║                                                                   ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
    
    validateConfig();
    
    utils.log('CONFIG', 'Configuration:');
    utils.log('CONFIG', `  Appsmith URL:  ${config.appsmithUrl}`);
    utils.log('CONFIG', `  Admin Email:   ${config.admin.email}`);
    utils.log('CONFIG', `  Admin Name:    ${config.admin.firstName} ${config.admin.lastName}`);
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
            slowMo: config.playwright.slowMo,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        
        context = await browser.newContext({
            viewport: { width: 1920, height: 947 }, // From recording
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
        
        // Execute automation steps
        // Note: After signup completes, user is already logged in, no separate login needed
        // Note: Datasource configuration is included in the JSON file, no need to configure separately
        await waitForAppsmith(page);
        await createAdminAccount(page);  // Creates account and leaves user logged in
        await importFromJson(page);
        
        // Get the actual NetSwift URL (login page ID is dynamic)
        const netswiftUrl = await getNetSwiftUrl(page);
        
        // Import is complete - datasource and deployment are already in the JSON
        utils.success('COMPLETE', 'NetSwift application imported successfully!');
        
        success = true;
        
        // Get server IP for instructions
        const serverIp = config.appsmithUrl.replace('http://', '').replace('https://', '').split(':')[0];
        
        console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║                                                                   ║');
        console.log('║              ✅ AUTOMATION COMPLETED SUCCESSFULLY!                ║');
        console.log('║                                                                   ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
        
        console.log('╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║                                                                   ║');
        console.log('║                    📋 HOW TO ACCESS NETSWIFT                      ║');
        console.log('║                                                                   ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
        
        utils.log('INFO', '🌐 STEP 1: Open NetSwift in your browser');
        if (netswiftUrl) {
            utils.log('INFO', `   URL: ${netswiftUrl}`);
        } else {
            utils.log('INFO', `   URL: http://${serverIp}/applications`);
            utils.log('INFO', '   (Then click on the NetSwift application)');
        }
        utils.log('INFO', '');
        
        utils.log('INFO', '🔐 STEP 2: Login to Appsmith (if prompted)');
        utils.log('INFO', `   Email:    ${config.admin.email}`);
        utils.log('INFO', `   Password: ${config.admin.password}`);
        utils.log('INFO', '');
        
        utils.log('INFO', '🎯 STEP 3: Login to NetSwift Application');
        utils.log('INFO', '   Username: admin');
        utils.log('INFO', '   Password: admin');
        utils.log('INFO', '');
        
        console.log('╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║                                                                   ║');
        console.log('║                        🎉 SETUP COMPLETE!                         ║');
        console.log('║                                                                   ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
        
        utils.log('INFO', '📝 Admin Credentials Summary:');
        utils.log('INFO', `   Appsmith Admin: ${config.admin.email} / ${config.admin.password}`);
        utils.log('INFO', `   NetSwift App:   admin / admin`);
        utils.log('INFO', '');
        if (netswiftUrl) {
            utils.log('INFO', `🔗 Direct Link: ${netswiftUrl}`);
        } else {
            utils.log('INFO', `🔗 Applications: http://${serverIp}/applications`);
        }
        
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
            if (!config.playwright.headless && !success) {
                utils.log('BROWSER', 'Automation failed - keeping browser open for inspection...');
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
