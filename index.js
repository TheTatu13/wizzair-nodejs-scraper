/**
 * Wizz Air Job Scraper - Main Entry Point
 * 
 * PURPOSE: Scrapes job listings from Wizz Air Careers and stores them in Solr.
 * This is the primary orchestrator that coordinates company validation, job scraping,
 * data transformation, and Solr storage.
 */

import { fetchWithRetry as fetch, assertCanary } from "./src/premium.js";
import * as cheerio from "cheerio";
import fs from "fs";
import { fileURLToPath } from "url";
import { validateAndGetCompany } from "./company.js";
import { querySOLR, deleteJobByUrl, upsertJobs, upsertCompany } from "./solr.js";
import { generateJobsMarkdown } from "./src/markdown-generator.js";
import companyConfig from "./config/company.js";

// ============================================================================
// CONFIGURATION CONSTANTS — derived from config/company.json
// ============================================================================

const COMPANY_CIF = companyConfig.cif;
const JOB_BASE = companyConfig.apiBase;

// Request timeout in milliseconds (10 seconds)
const TIMEOUT = 10000;

// Number of jobs to fetch per API page request
const PAGE_SIZE = 10;

// Global variable to store company name after validation
let COMPANY_NAME = null;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Promise-based sleep function to introduce delays between requests
 * @param {number} ms - Milliseconds to sleep
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Searches ANOFM (Agentia Nationala pentru Ocuparea Fortei de Munca) for
 * job listings belonging to the given company CIF. Uses the public ANOFM API.
 * @param {string} cif - Company CIF
 * @returns {Promise<Array>} - Array of job objects { url, title, location, source }
 */
async function searchANOFM(cif) {
  const jobs = [];
  try {
    console.log(`Searching ANOFM by CIF: ${cif}`);
    const payload = {
      current: 1,
      rowCount: 250,
      sort: { created_at: "desc" },
      employer_tax_code: cif
    };
    const res = await fetch("https://mediere.anofm.ro/api/entity/vw_public_job_posting", {
      method: "POST",
      timeout: TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "job_seeker_ro_spider"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log(`  ANOFM returned ${res.status}`);
      return jobs;
    }
    const data = await res.json();
    for (const row of data.rows || []) {
      const locationParts = (row.address_locality_name || '').split('>').map(s => s.trim());
      const location = locationParts.length > 1 ? locationParts[locationParts.length - 1] : locationParts[0];
      jobs.push({
        url: `https://mediere.anofm.ro/app/module/mediere/job/${row.id}`,
        title: row.occupation,
        location: location ? [location] : undefined,
        source: "ANOFM"
      });
    }
    console.log(`  Found ${jobs.length} jobs on ANOFM`);
  } catch (err) {
    console.log(`  ANOFM error: ${err.message}`);
  }
  return jobs;
}

// ============================================================================
// WIZZ AIR CAREERS (SAP SuccessFactors career site)
// Source of truth = sitemap.xml (every open job) + one HTML page per job.
// The geo line looks like "Otopeni, RO, 75100": we keep only country code RO.
// ============================================================================

const SITEMAP_URL = `${JOB_BASE}/sitemap.xml`;
const PAGE_DELAY_MS = 400;
const BROWSER_HEADERS = {
  "User-Agent": "job_seeker_ro_spider",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

/**
 * Extracts every job URL from the sitemap XML
 * @param {string} xml - Raw sitemap.xml
 * @returns {string[]} - Unique absolute job URLs
 */
export function parseSitemap(xml) {
  const urls = [...String(xml || "").matchAll(/<loc>\s*(https?:\/\/[^<\s]+\/job\/[^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  return [...new Set(urls)];
}

/**
 * Parses one job page. Every field has fallbacks (premium rule: no single fragile selector).
 * @param {string} html - Job page HTML
 * @param {string} url - Job URL (used as unique key)
 * @returns {Object|null} - { url, title, city, country, datePosted } or null when unusable
 */
export function parseJobPage(html, url) {
  const $ = cheerio.load(html || "");

  const title =
    $("[itemprop='title']").first().text().trim() ||
    $("h1").first().text().trim() ||
    $("title").first().text().replace(/\s*Job Details.*$/i, "").trim();

  const geo =
    $(".jobGeoLocation").first().text().trim() ||
    $("meta[itemprop='streetAddress']").attr("content") ||
    "";
  const parts = geo.split(",").map((s) => s.trim()).filter(Boolean);
  const city = parts[0] || "";
  const country = (parts[1] || "").toUpperCase();

  const canonical = $("link[rel='canonical']").attr("href") || url;
  if (!title) return null;

  return {
    url: canonical,
    title,
    city,
    country,
    datePosted: $("meta[itemprop='datePosted']").attr("content") || undefined
  };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, timeout: TIMEOUT });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// ============================================================================
// SCRAPING LOGIC
// ============================================================================

/**
 * Scrapes all Romanian jobs from Wizz Air careers
 * @param {boolean} testOnlyOnePage - If true, inspects only the first 5 job pages (for testing)
 * @returns {Promise<Array>} - Array of unique job objects { url, title, location }
 */
async function scrapeAllListings(testOnlyOnePage = false) {
  console.log(`Fetching sitemap: ${SITEMAP_URL}`);
  const sitemapUrls = parseSitemap(await fetchText(SITEMAP_URL));
  console.log(`Total jobs on site: ${sitemapUrls.length}`);

  // Canary: a careers site with 0 jobs in the sitemap means the layout/endpoint changed
  if (sitemapUrls.length === 0) {
    throw new Error("Sitemap contains no job URLs - the careers site probably changed");
  }

  const urls = testOnlyOnePage ? sitemapUrls.slice(0, 5) : sitemapUrls;
  const allJobs = [];
  const seenUrls = new Set();
  let failedPages = 0;

  for (const url of urls) {
    try {
      const job = parseJobPage(await fetchText(url), url);
      if (!job) {
        console.log(`  Skipping (no title): ${url}`);
        failedPages++;
      } else if (job.country === "RO" && !seenUrls.has(job.url)) {
        seenUrls.add(job.url);
        allJobs.push({ url: job.url, title: job.title, location: job.city ? [job.city] : undefined });
        console.log(`  RO job: ${job.title} (${job.city})`);
      }
    } catch (err) {
      failedPages++;
      console.log(`  Page failed (${err.message})`);
    }
    await sleep(PAGE_DELAY_MS);
  }

  // If most pages failed we cannot trust an empty/short result
  if (failedPages > urls.length / 2) {
    throw new Error(`Too many job pages failed (${failedPages}/${urls.length})`);
  }

  console.log(`Total unique Romanian jobs collected: ${allJobs.length}`);
  return allJobs;
}
// ============================================================================
// DATA TRANSFORMATION - Preparing jobs for Solr storage
// ============================================================================

/**
 * Maps raw job data to Solr-compatible job model with timestamps and status
 * @param {Object} rawJob - Job object from scraper
 * @param {string} cif - Company identifier
 * @param {string} companyName - Company name
 * @returns {Object} - Job object ready for Solr storage
 */
function mapToJobModel(rawJob, cif, companyName = COMPANY_NAME) {
  const now = new Date().toISOString();

  const job = {
    url: rawJob.url,
    title: rawJob.title,
    company: companyName,
    cif: cif,
    location: rawJob.location?.length ? rawJob.location : undefined,
    tags: rawJob.tags?.length ? rawJob.tags : undefined,
    workmode: rawJob.workmode || undefined,
    date: now,
    status: "scraped"
  };

  // Remove undefined fields to keep payload clean
  Object.keys(job).forEach((k) => job[k] === undefined && delete job[k]);

  return job;
}

/**
 * Transforms jobs to match Solr schema and filters for Romanian locations
 * - Ensures company name is uppercase
 * - Filters locations to only Romanian cities
 * - Normalizes work mode values
 * @param {Object} payload - Job payload with jobs array
 * @returns {Object} - Transformed payload ready for Solr
 */
function transformJobsForSOLR(payload) {
  // List of Romanian cities for location validation
  // Includes both Romanian and English spellings with diacritics
  const romanianCities = [
    'Bucharest', 'București', 'Cluj-Napoca', 'Cluj Napoca',
    'Timișoara', 'Timisoara', 'Iași', 'Iasi', 'Brașov', 'Brasov',
    'Constanța', 'Constanta', 'Craiova', 'Bacău', 'Sibiu',
    'Târgu Mureș', 'Targu Mures', 'Oradea', 'Baia Mare', 'Satu Mare',
    'Ploiești', 'Ploiesti', 'Pitești', 'Pitesti', 'Arad', 'Galați', 'Galati',
    'Brăila', 'Braila', 'Drobeta-Turnu Severin', 'Râmnicu Vâlcea', 'Ramnicu Valcea',
    'Buzău', 'Buzau', 'Botoșani', 'Botosani', 'Zalău', 'Zalau', 'Hunedoara', 'Deva',
    'Suceava', 'Bistrița', 'Bistrita', 'Tulcea', 'Călărași', 'Calarasi',
    'Giurgiu', 'Alba Iulia', 'Slatina', 'Piatra Neamț', 'Piatra Neamt', 'Roman',
    'Dumbrăvița', 'Dumbravita', 'Voluntari', 'Popești-Leordeni', 'Popesti-Leordeni',
    'Chitila', 'Mogoșoaia', 'Mogosoaia', 'Otopeni'
  ];

  // Create lookup set for O(1) city validation
  const citySet = new Set(romanianCities.map(c => c.toLowerCase()));

  /**
   * Normalizes work mode strings to standard values
   * @param {string} wm - Raw work mode string
   * @returns {string|undefined} - Normalized work mode
   */
  const normalizeWorkmode = (wm) => {
    if (!wm) return undefined;
    const lower = wm.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('office') || lower.includes('on-site') || lower.includes('site')) return 'on-site';
    return 'hybrid';
  };

  // Transform the payload
  const transformed = {
    ...payload,
    company: payload.company?.toUpperCase(), // Solr convention: uppercase company names
    jobs: payload.jobs.map(job => {
      // Filter locations to only include valid Romanian cities
      // Also accept generic "Romania" or "România" as valid
      const validLocations = (job.location || []).filter(loc => {
        const lower = loc.toLowerCase().trim();
        if (lower === 'romania' || lower === 'românia') return true;
        return citySet.has(lower);
      }).map(loc => loc.toLowerCase() === 'romania' ? 'România' : loc);

      return {
        ...job,
        location: validLocations.length > 0 ? validLocations : ['România'], // Default to Romania if no city match
        workmode: normalizeWorkmode(job.workmode)
      };
    })
  };

  return transformed;
}

// ============================================================================
// MAIN ORCHESTRATION - Coordinates the entire scraping workflow
// ============================================================================

/**
 * Main function that orchestrates the complete scraping workflow:
 * 1. Check existing jobs in Solr
 * 2. Validate company via ANAF
 * 3. Scrape jobs from Wizz Air Careers (sitemap + job pages)
 * 4. Transform data for Solr
 * 5. Upsert jobs to Solr
 * 6. Report summary
 */
async function main() {
  // Check for --test flag to run in test mode (single page only)
  const testOnlyOnePage = process.argv.includes("--test");
  
  try {
    // Ensure tmp/ directory exists (for jobs.json and company.json backups)
    fs.mkdirSync("tmp", { recursive: true });
    // Step 1: Get count of existing jobs in Solr for comparison
    console.log("=== Step 1: Get existing jobs count ===");
    const existingResult = await querySOLR(COMPANY_CIF);
    const existingCount = existingResult.numFound;
    console.log(`Found ${existingCount} existing jobs in SOLR`);
    console.log("(Keeping existing jobs - will upsert Wizz Air Careers jobs only)");

    // Step 2: Validate company data via ANAF (ensures we have correct company info)
    console.log("=== Step 2: Validate company via ANAF ===");
    const { company, cif, address } = await validateAndGetCompany();
    COMPANY_NAME = company;
    const localCif = cif;

    // Upsert company to SOLR company core with full address from ANAF
    try {
      await upsertCompany({
        id: cif,
        company,
        brand: companyConfig.brand,
        status: "activ",
        location: address ? [address] : [companyConfig.defaultLocation],
        website: [companyConfig.website],
        career: [companyConfig.careerUrl],
        lastScraped: new Date().toISOString().split('T')[0],
        scraperFile: companyConfig.scraperFile
      });
    } catch (err) {
      console.log(`Note: Could not upsert company to SOLR core: ${err.message}`);
    }
    
    // Step 3: Scrape all Romanian jobs from Wizz Air Careers
    const rawJobs = await scrapeAllListings(testOnlyOnePage);
    const scrapedCount = rawJobs.length;
    assertCanary({ scraped: scrapedCount, existing: existingCount, source: "careers site" });
    console.log(`📊 Jobs scraped from Wizz Air Careers website: ${scrapedCount}`);

    // Step 3b: Also scrape ANOFM jobs for this CIF
    if (!testOnlyOnePage) {
      const anofmJobs = await searchANOFM(localCif);
      const anofmCount = anofmJobs.length;
      for (const job of anofmJobs) {
        if (!rawJobs.find(j => j.url === job.url)) {
          rawJobs.push(job);
        }
      }
      console.log(`📊 Jobs added from ANOFM: ${anofmCount}`);
    }

    // Step 4: Map raw jobs to Solr model with CIF and company name
    const jobs = rawJobs.map(job => mapToJobModel(job, localCif));

    // Create payload with metadata
    const payload = {
      source: "careers.wizzair.com",
      scrapedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: localCif,
      jobs
    };

    // Step 5: Transform jobs (filter locations, normalize values)
    console.log("Transforming jobs for SOLR...");
    const transformedPayload = transformJobsForSOLR(payload);
    const validCount = transformedPayload.jobs.filter(j => j.location).length;
    console.log(`📊 Jobs with valid Romanian locations: ${validCount}`);

    // Save transformed jobs to file (for debugging/backup)
    fs.writeFileSync("tmp/jobs.json", JSON.stringify(transformedPayload, null, 2), "utf-8");
    console.log("Saved tmp/jobs.json");

    // Generate and save docs/jobs.md
    const companyData = {
      id: localCif,
      company: transformedPayload.company,
      brand: companyConfig.brand,
      status: "activ",
      location: address ? [address] : [companyConfig.defaultLocation],
      website: [companyConfig.website],
      career: [companyConfig.careerUrl],
      lastScraped: new Date().toISOString().split('T')[0]
    };
    const markdown = generateJobsMarkdown(companyData, transformedPayload.jobs);
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/jobs.md", markdown, "utf-8");
    console.log("Saved docs/jobs.md");

    // Publish a copy of company config for the static HTML to consume
    fs.writeFileSync("docs/company.json", JSON.stringify(companyConfig, null, 2), "utf-8");
    console.log("Saved docs/company.json");

    // Step 6: Upsert all jobs to Solr (add/update)
    console.log("\n=== Step 6: Upsert jobs to SOLR ===");
    await upsertJobs(transformedPayload.jobs);

    // Step 7: Verify final count in Solr
    const finalResult = await querySOLR(COMPANY_CIF);
    console.log(`\n📊 === SUMMARY ===`);
    console.log(`📊 Jobs existing in SOLR before scrape: ${existingCount}`);
    console.log(`📊 Jobs scraped from Wizz Air website: ${scrapedCount}`);
    console.log(`📊 Jobs in SOLR after scrape: ${finalResult.numFound}`);
    console.log(`====================`);

    console.log("\n=== DONE ===");
    console.log("Scraper completed successfully!");

  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

// Export functions for testing
export { scrapeAllListings, mapToJobModel, transformJobsForSOLR };

// Run main function when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
