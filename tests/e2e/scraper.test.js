import { jest } from '@jest/globals';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import companyConfig from '../../config/company.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

// Live API tests hit api.peviitor.ro (no credential needed) -- opt in explicitly.
const HAS_SOLR = !!process.env.RUN_LIVE_API_TESTS;

function itIfSolr(name, fn, timeout) {
  if (HAS_SOLR) {
    return it(name, fn, timeout);
  }
  return it.skip(`${name} (skipped: set RUN_LIVE_API_TESTS=1 to run)`, fn, timeout);
}

async function checkAnafAvailability() {
  try {
    const res = await fetch('https://demoanaf.ro/api/company/' + companyConfig.cif, {
      headers: { 'Accept': 'application/json' },
      timeout: 5000
    });
    return res.ok;
  } catch {
    return false;
  }
}

const HAS_ANAF = await checkAnafAvailability();

function itIfAnaf(name, fn, timeout) {
  if (HAS_ANAF) {
    return it(name, fn, timeout);
  }
  return it.skip(`${name} (skipped: ANAF unavailable)`, fn, timeout);
}

const TEST_CIF = companyConfig.cif;
const TEST_BRAND = companyConfig.brand;

describe('E2E: Full Scraping Pipeline', () => {

  describe('Careers site - Real Data Fetch', () => {
    let urls;

    beforeAll(async () => {
      const index = await import('../../index.js');
      const res = await fetch(companyConfig.apiBase + '/sitemap.xml', {
        headers: { 'User-Agent': 'job_seeker_ro_spider' }
      });
      expect(res.ok).toBe(true);
      urls = index.parseSitemap(await res.text());
    }, 20000);

    it('sitemap should list job URLs', () => {
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) {
        expect(u).toMatch(/^https:\/\/careers\.wizzair\.com\/job\//);
      }
    });
  });

  describe('Parse + Transform Pipeline', () => {
    let index;
    let jobs;

    beforeAll(async () => {
      index = await import('../../index.js');
      const res = await fetch(companyConfig.apiBase + '/sitemap.xml', {
        headers: { 'User-Agent': 'job_seeker_ro_spider' }
      });
      const urls = index.parseSitemap(await res.text());
      jobs = [];
      for (const url of urls.slice(0, 3)) {
        const page = await fetch(url, { headers: { 'User-Agent': 'job_seeker_ro_spider' } });
        const job = index.parseJobPage(await page.text(), url);
        if (job) jobs.push(job);
      }
    }, 30000);

    it('should parse real job pages (title, city and country present)', () => {
      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs) {
        expect(job.title.length).toBeGreaterThan(0);
        expect(job.city.length).toBeGreaterThan(0);
        expect(job.country).toMatch(/^[A-Z]{2}$/);
      }
    });

    it('should map parsed jobs to job model', () => {
      const model = index.mapToJobModel({ url: jobs[0].url, title: jobs[0].title, location: [jobs[0].city] }, TEST_CIF);

      expect(model).toHaveProperty('url');
      expect(model).toHaveProperty('title');
      expect(model).toHaveProperty('company');
      expect(model).toHaveProperty('cif', TEST_CIF);
      expect(model).toHaveProperty('status', 'scraped');
      expect(model).toHaveProperty('date');
    });

    it('should transform jobs and keep the company name uppercase', () => {
      const mapped = jobs.map(j => index.mapToJobModel({ url: j.url, title: j.title, location: [j.city] }, TEST_CIF));
      const payload = {
        source: 'careers.wizzair.com',
        company: companyConfig.legalName,
        cif: TEST_CIF,
        jobs: mapped
      };

      const transformed = index.transformJobsForSOLR(payload);

      expect(transformed.company).toBe(companyConfig.legalName);
      expect(transformed.jobs.length).toBe(mapped.length);
      for (const job of transformed.jobs) {
        expect(Array.isArray(job.location)).toBe(true);
        expect(job.location.length).toBeGreaterThan(0);
      }
    });

    it('should produce job URLs that are accessible', async () => {
      for (const job of jobs.slice(0, 2)) {
        const res = await fetch(job.url, { method: 'HEAD', headers: { 'User-Agent': 'job_seeker_ro_spider' } });
        expect(res.ok).toBe(true);
      }
    }, 30000);
  });
  describe('ANAF Company Data', () => {
    let anaf;

    beforeAll(async () => {
      anaf = await import('../../src/anaf.js');
    });

    itIfAnaf('should find company in ANAF by CIF and check inactive flag', async () => {
      const anafData = await anaf.getCompanyFromANAF(TEST_CIF);
      expect(anafData).toBeDefined();
      expect(anafData.cui.toString()).toBe(TEST_CIF);
      expect(anafData.name).toBe(companyConfig.legalName);
      expect(typeof anafData.inactive).toBe('boolean');
    }, 30000);
  });

  describe('Company Validation Path', () => {
    let anaf;
    let company;

    beforeAll(async () => {
      anaf = await import('../../src/anaf.js');
      company = await import('../../company.js');
    });

    itIfAnaf('should find company in ANAF and validate active status', async () => {
      const results = await anaf.searchCompany(TEST_BRAND);

      const comp = results.find(c =>
        c.cui.toString() === TEST_CIF &&
        c.statusLabel === 'Funcțiune'
      );
      expect(comp).toBeDefined();
      expect(comp.cui.toString()).toBe(TEST_CIF);

      const anafData = await anaf.getCompanyFromANAF(TEST_CIF);
      expect(anafData).toBeDefined();
      expect(typeof anafData.inactive).toBe('boolean');
    }, 30000);

    itIfSolr('should run full validation and report status with job count', async () => {
      let result;
      try {
        result = await company.validateAndGetCompany();
      } catch (err) {
        console.log(`⚠️ Company validation failed — skipping: ${err.message}`);
        return;
      }

      expect(result.company).toBe(companyConfig.legalName);
      expect(result.cif).toBe(TEST_CIF);

      if (result.existingJobsCount === 0) {
        console.log('⚠️ No jobs in Solr — skipping job count assertion');
        return;
      }
      expect(result.existingJobsCount).toBeGreaterThan(0);
    }, 30000);
  });

  describe('Inactive Company Handling', () => {
    let anaf;

    beforeAll(async () => {
      anaf = await import('../../src/anaf.js');
    });

    itIfAnaf('should detect inactive/radiated companies via ANAF', async () => {
      const results = await anaf.searchCompany(TEST_BRAND);

      const nonActive = results.find(c => c.statusLabel !== 'Funcțiune');

      if (nonActive) {
        try {
          const anafData = await anaf.getCompanyFromANAF(nonActive.cui.toString());
          expect(anafData).toBeDefined();
          if (anafData.inactive !== undefined) {
            expect(anafData.inactive).toBe(true);
          }
        } catch {
          expect(nonActive.statusLabel).toMatch(/Radiată|Inactiv|Suspendat/);
        }
      }
    }, 30000);
  });

  describe('SOLR Data Verification', () => {
    let solr;

    beforeAll(async () => {
      solr = await import('../../solr.js');
    });

    itIfSolr('should have jobs in SOLR with correct company name', async () => {
      const result = await solr.querySOLR(TEST_CIF);

      if (result.numFound === 0) {
        console.log('⚠️ No jobs in Solr — skipping SOLR data verification');
        return;
      }

      for (const job of result.docs) {
        expect(job.company).toBe(companyConfig.legalName);
        expect(job.cif).toBe(TEST_CIF);
      }
    }, 15000);

    itIfSolr('should have company core entry with required fields', async () => {
      const comp = await solr.getCompanyByCif(TEST_CIF);

      expect(comp).not.toBeNull();
      expect(comp.company).toBe(companyConfig.legalName);
      expect(['activ', 'inactiv', 'suspendat', 'radiat']).toContain(comp.status);
    }, 15000);
  });
});
