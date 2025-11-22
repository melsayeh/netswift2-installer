#!/usr/bin/env node
/**
 * Appsmith Full Automation Script - JSON Import Version
 * 
 * This script uses Puppeteer to automate the Appsmith web UI:
 * 1. Create admin account
 * 2. Import application from JSON file
 * 3. Configure datasource
 * 4. Deploy application
 * 
 * Usage:
 *   npm install puppeteer
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
 */

const puppeteer = require('puppeteer');
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
    puppeteer: {
        headless: process.env.HEADLESS !== 'false',
        timeout: parseInt(process.env.TIMEOUT || '90000')
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
    
    waitForNavigation: async (page, options = {}) => {
        try {
            await page.waitForNavigation({ 
                waitUntil: 'networkidle2', 
                timeout: config.puppeteer.timeout,
                ...options 
            });
        } catch (error) {
            utils.log('NAVIGATION', 'Navigation timeout, checking if page loaded...');
            await utils.sleep(2000);
        }
    },
    
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
            await page.goto(`${config.appsmithUrl}/api/v1/health`, {
                waitUntil: 'networkidle2',
                timeout: 10000
            });
            
            const content = await page.content();
            if (content.includes('success') || content.includes('ok')) {
                utils.success(step, 'Appsmith is ready');
                return true;
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
        // Navigate to signup page
        await page.goto(`${config.appsmithUrl}/setup/welcome`, {
            waitUntil: 'networkidle2',
            timeout: config.puppeteer.timeout
        });
        
        await utils.sleep(2000);
        utils.log(step, 'Signup page loaded');
        
        // Wait for signup form
        await page.waitForSelector('input[type="email"], input[name="email"]', {
            timeout: config.puppeteer.timeout
        });
        
        utils.log(step, 'Filling signup form...');
        
        // Find and fill email
        const emailSelectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="email" i]'
        ];
        
        for (const selector of emailSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click({ clickCount: 3 });
                    await element.type(config.admin.email, { delay: 50 });
                    utils.log(step, 'Email entered');
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        await utils.sleep(500);
        
        // Find and fill password
        const passwordSelectors = [
            'input[type="password"]',
            'input[name="password"]'
        ];
        
        for (const selector of passwordSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click({ clickCount: 3 });
                    await element.type(config.admin.password, { delay: 50 });
                    utils.log(step, 'Password entered');
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        await utils.sleep(500);
        
        // Try to fill name if field exists
        try {
            const nameSelectors = [
                'input[name="name"]',
                'input[placeholder*="name" i]'
            ];
            
            for (const selector of nameSelectors) {
                const element = await page.$(selector);
                if (element) {
                    await element.click({ clickCount: 3 });
                    await element.type(config.admin.name, { delay: 50 });
                    utils.log(step, 'Name entered');
                    break;
                }
            }
        } catch (e) {
            utils.log(step, 'Name field not found or not required');
        }
        
        await utils.sleep(1000);
        utils.log(step, 'Form filled, submitting...');
        
        // Submit the form
        const submitSelectors = [
            'button[type="submit"]',
            'button:has-text("Sign Up")',
            'button:has-text("Get Started")',
            'button:has-text("Create Account")',
            'button:has-text("Sign up")',
            '.signup-submit',
            '.submit-button'
        ];
        
        let submitted = false;
        for (const selector of submitSelectors) {
            try {
                const button = await page.$(selector);
                if (button) {
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
            // Try pressing Enter
            utils.log(step, 'Trying to submit with Enter key...');
            await page.keyboard.press('Enter');
        }
        
        utils.log(step, 'Form submitted, waiting for redirect...');
        
        // Wait for redirect to home/workspace
        await utils.sleep(5000);
        
        const currentUrl = page.url();
        utils.log(step, `Current URL: ${currentUrl}`);
        
        // Check if we're on the home page
        if (currentUrl.includes('/applications') || 
            currentUrl.includes('/home') || 
            currentUrl.includes('/workspace')) {
            utils.success(step, `Admin account created: ${config.admin.email}`);
            return true;
        }
        
        // Additional verification
        try {
            await page.waitForSelector('.workspace, [class*="workspace"], [class*="home"]', { 
                timeout: 10000 
            });
            utils.success(step, `Admin account created: ${config.admin.email}`);
            return true;
        } catch (e) {
            throw new Error('Account creation might have failed - did not reach workspace');
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
        // Make sure we're on the applications page
        await page.goto(`${config.appsmithUrl}/applications`, {
            waitUntil: 'networkidle2',
            timeout: config.puppeteer.timeout
        });
        
        await utils.sleep(2000);
        utils.log(step, 'On applications page');
        
        // Look for "Create New" or "Import" button
        utils.log(step, 'Looking for Create/Import button...');
        
        const createButtonSelectors = [
            'button:has-text("Create New")',
            'button:has-text("Import")',
            'button:has-text("Create new")',
            '[data-testid="t--create-new-button"]',
            '[class*="create-new"]',
            '[class*="import"]'
        ];
        
        let buttonClicked = false;
        for (const selector of createButtonSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                buttonClicked = true;
                utils.log(step, `Clicked button: ${selector}`);
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!buttonClicked) {
            // Try clicking by text content
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, a'));
                const button = buttons.find(b => 
                    b.textContent.includes('Create New') || 
                    b.textContent.includes('Import') ||
                    b.textContent.includes('Create new')
                );
                if (button) button.click();
            });
        }
        
        await utils.sleep(2000);
        
        // Look for "Import" option in dropdown/modal
        utils.log(step, 'Looking for Import option...');
        
        const importOptionSelectors = [
            'text=Import',
            'button:has-text("Import")',
            '[data-testid="t--import"]',
            '[class*="import"]',
            'div:has-text("Import")',
            'span:has-text("Import")'
        ];
        
        let importClicked = false;
        for (const selector of importOptionSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                importClicked = true;
                utils.log(step, `Clicked import option: ${selector}`);
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!importClicked) {
            // Try clicking by text
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('*'));
                const element = elements.find(el => 
                    el.textContent.trim() === 'Import' &&
                    (el.tagName === 'BUTTON' || el.tagName === 'DIV' || el.tagName === 'SPAN')
                );
                if (element) element.click();
            });
        }
        
        await utils.sleep(2000);
        
        // Look for file upload input
        utils.log(step, 'Looking for file upload input...');
        
        const fileInputSelectors = [
            'input[type="file"]',
            'input[accept*="json"]',
            'input[name*="file"]'
        ];
        
        let fileInput;
        for (const selector of fileInputSelectors) {
            try {
                fileInput = await page.$(selector);
                if (fileInput) {
                    utils.log(step, `Found file input: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!fileInput) {
            // File input might be hidden, try to find it
            fileInput = await page.evaluateHandle(() => {
                const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
                return inputs[0] || null;
            });
            
            if (!fileInput || !fileInput.asElement()) {
                throw new Error('Could not find file upload input');
            }
        }
        
        // Upload the JSON file
        utils.log(step, `Uploading file: ${config.app.jsonPath}`);
        await fileInput.uploadFile(config.app.jsonPath);
        utils.log(step, 'File uploaded');
        
        await utils.sleep(3000);
        
        // Click "Import" or "Upload" button to confirm
        const confirmButtonSelectors = [
            'button:has-text("Import")',
            'button:has-text("Upload")',
            'button:has-text("Continue")',
            'button[type="submit"]'
        ];
        
        for (const selector of confirmButtonSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                utils.log(step, `Clicked confirm button: ${selector}`);
                break;
            } catch (e) {
                continue;
            }
        }
        
        utils.log(step, 'Waiting for import to complete...');
        
        // Wait for import to finish (datasource modal or editor appears)
        await page.waitForFunction(
            () => {
                const url = window.location.href;
                return url.includes('/edit') || 
                       url.includes('/editor') ||
                       document.querySelector('[class*="datasource"]') !== null ||
                       document.querySelector('[class*="reconnect"]') !== null;
            },
            { timeout: 120000 }
        );
        
        await utils.sleep(3000);
        utils.success(step, 'Application imported from JSON');
        return true;
        
    } catch (error) {
        utils.error(step, 'Failed to import from JSON', error);
        await utils.takeScreenshot(page, 'import-error');
        throw error;
    }
}

// Step 4: Configure datasource
async function configureDatasource(page) {
    const step = 'DATASOURCE';
    utils.log(step, 'Configuring datasource...');
    
    try {
        await utils.sleep(3000);
        
        // Check if datasource configuration modal is present
        utils.log(step, 'Looking for datasource modal...');
        
        const modalIndicators = [
            'text=Reconnect Datasources',
            'text=Reconnect datasources',
            'text=Configure Datasources',
            '[class*="datasource-modal"]',
            '[class*="reconnect-modal"]'
        ];
        
        let modalFound = false;
        for (const indicator of modalIndicators) {
            try {
                await page.waitForSelector(indicator, { timeout: 10000 });
                modalFound = true;
                utils.log(step, 'Datasource modal found');
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!modalFound) {
            utils.log(step, 'No datasource modal found, checking if already configured...');
            
            // Check if we're in the editor
            const url = page.url();
            if (url.includes('/edit') || url.includes('/editor')) {
                utils.log(step, 'Already in editor, datasource might be configured');
                return true;
            }
            
            // Look for datasource in sidebar
            try {
                await page.goto(`${config.appsmithUrl}/applications`, {
                    waitUntil: 'networkidle2',
                    timeout: config.puppeteer.timeout
                });
                
                // Click on the imported app
                await page.evaluate(() => {
                    const apps = Array.from(document.querySelectorAll('[class*="application"]'));
                    if (apps.length > 0) {
                        apps[0].click();
                    }
                });
                
                await utils.sleep(3000);
            } catch (e) {
                utils.log(step, 'Could not navigate to app');
            }
            
            return true;
        }
        
        // Find URL input field
        utils.log(step, 'Looking for datasource URL input...');
        
        const urlInputSelectors = [
            'input[placeholder*="URL" i]',
            'input[placeholder*="url" i]',
            'input[name*="url" i]',
            'input[type="text"]',
            'input[type="url"]'
        ];
        
        let urlConfigured = false;
        for (const selector of urlInputSelectors) {
            try {
                const inputs = await page.$$(selector);
                for (const input of inputs) {
                    const isVisible = await input.boundingBox();
                    if (isVisible) {
                        // Check if this is likely the URL field
                        const placeholder = await page.evaluate(el => el.placeholder, input);
                        const name = await page.evaluate(el => el.name, input);
                        
                        if ((placeholder && placeholder.toLowerCase().includes('url')) ||
                            (name && name.toLowerCase().includes('url'))) {
                            await input.click({ clickCount: 3 });
                            await input.type(config.datasource.url, { delay: 50 });
                            utils.log(step, `URL configured: ${config.datasource.url}`);
                            urlConfigured = true;
                            break;
                        }
                    }
                }
                if (urlConfigured) break;
            } catch (e) {
                continue;
            }
        }
        
        if (!urlConfigured) {
            utils.log(step, 'Could not find URL field, might already be configured');
        }
        
        await utils.sleep(1000);
        
        // Click "Test" button if available
        try {
            const testButton = await page.$('button:has-text("Test")');
            if (testButton) {
                await testButton.click();
                utils.log(step, 'Clicked Test button');
                await utils.sleep(2000);
            }
        } catch (e) {
            utils.log(step, 'Test button not found or not needed');
        }
        
        // Click "Save" button
        const saveSelectors = [
            'button:has-text("Save")',
            'button:has-text("Save & Authorize")',
            'button[type="submit"]'
        ];
        
        for (const selector of saveSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                utils.log(step, 'Clicked Save button');
                await utils.sleep(2000);
                break;
            } catch (e) {
                continue;
            }
        }
        
        // Close modal
        const closeSelectors = [
            'button:has-text("Continue")',
            'button:has-text("Done")',
            'button:has-text("Close")',
            '[class*="modal-close"]',
            '[class*="close-button"]'
        ];
        
        for (const selector of closeSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                utils.log(step, 'Closed datasource modal');
                break;
            } catch (e) {
                continue;
            }
        }
        
        await utils.sleep(2000);
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
            utils.log(step, 'Not in editor, navigating to app...');
            
            await page.goto(`${config.appsmithUrl}/applications`, {
                waitUntil: 'networkidle2',
                timeout: config.puppeteer.timeout
            });
            
            await utils.sleep(2000);
            
            // Click on the first app
            await page.evaluate(() => {
                const apps = Array.from(document.querySelectorAll('[class*="application-card"], [class*="app-card"]'));
                if (apps.length > 0) {
                    apps[0].click();
                }
            });
            
            await utils.sleep(3000);
        }
        
        // Look for Deploy button
        utils.log(step, 'Looking for Deploy button...');
        
        const deploySelectors = [
            'button:has-text("Deploy")',
            'button:has-text("Publish")',
            '[data-testid="t--application-publish-btn"]',
            '[class*="deploy-button"]',
            '[class*="publish-button"]'
        ];
        
        let deployed = false;
        for (const selector of deploySelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 10000 });
                await page.click(selector);
                deployed = true;
                utils.log(step, `Clicked Deploy button: ${selector}`);
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!deployed) {
            // Try finding by text
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const deployBtn = buttons.find(b => 
                    b.textContent.includes('Deploy') || 
                    b.textContent.includes('Publish')
                );
                if (deployBtn) deployBtn.click();
            });
        }
        
        utils.log(step, 'Waiting for deployment...');
        await utils.sleep(5000);
        
        // Look for success message
        try {
            await page.waitForFunction(
                () => {
                    const text = document.body.textContent;
                    return text.includes('deployed successfully') ||
                           text.includes('published successfully') ||
                           text.includes('Application is live');
                },
                { timeout: 30000 }
            );
            utils.success(step, 'Application deployed successfully!');
        } catch (e) {
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
    console.log('║        Appsmith Full Automation - JSON Import Version            ║');
    console.log('║                                                                   ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
    
    // Validate configuration
    validateConfig();
    
    utils.log('CONFIG', 'Configuration:');
    utils.log('CONFIG', `  Appsmith URL:  ${config.appsmithUrl}`);
    utils.log('CONFIG', `  Admin Email:   ${config.admin.email}`);
    utils.log('CONFIG', `  JSON File:     ${config.app.jsonPath}`);
    utils.log('CONFIG', `  Datasource:    ${config.datasource.url}`);
    utils.log('CONFIG', `  Headless:      ${config.puppeteer.headless}\n`);
    
    let browser;
    let success = false;
    
    try {
        // Launch browser
        utils.log('BROWSER', 'Launching browser...');
        browser = await puppeteer.launch({
            headless: config.puppeteer.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
            defaultViewport: {
                width: 1920,
                height: 1080
            }
        });
        
        const page = await browser.newPage();
        
        // Set user agent
        await page.setUserAgent(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        
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
        if (browser) {
            if (config.puppeteer.headless && !success) {
                utils.log('BROWSER', 'Keeping browser open for debugging...');
                utils.log('BROWSER', 'Press Ctrl+C to close');
                await utils.sleep(300000); // 5 minutes
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
