import { jest } from '@jest/globals';

describe('index.js Component Tests', () => {
  let index;

  beforeAll(async () => {
    index = await import('../../index.js');
  });

  describe('transformJobsForSOLR', () => {
    it('should filter locations to only Romanian cities', () => {
      const payload = {
        jobs: [
          { url: 'https://test.com/1', title: 'Job 1', location: ['România'] },
          { url: 'https://test.com/2', title: 'Job 2', location: ['Bucharest'] },
          { url: 'https://test.com/3', title: 'Job 3', location: ['Bulgaria'] },
          { url: 'https://test.com/4', title: 'Job 4', location: ['Cluj-Napoca'] },
          { url: 'https://test.com/5', title: 'Job 5', location: [] }
        ]
      };

      const result = index.transformJobsForSOLR(payload);

      expect(result.jobs[0].location).toEqual(['România']);
      expect(result.jobs[1].location).toEqual(['Bucharest']);
      expect(result.jobs[2].location).toEqual(['România']);
      expect(result.jobs[3].location).toEqual(['Cluj-Napoca']);
      expect(result.jobs[4].location).toEqual(['România']);
    });

    it('should keep company uppercase', () => {
      const payload = {
        source: 'careers.wizzair.com',
        company: 'wizz air malta limited luqa - sucursala otopeni',
        cif: '46966293',
        jobs: [
          { url: 'https://test.com/1', title: 'Job 1', company: 'wizzair systems', cif: '46966293' }
        ]
      };

      const result = index.transformJobsForSOLR(payload);

      expect(result.company).toBe('WIZZ AIR MALTA LIMITED LUQA - SUCURSALA OTOPENI');
    });

    it('should normalize workmode values', () => {
      const payload = {
        jobs: [
          { url: 'https://test.com/1', title: 'Job 1', workmode: 'Remote' },
          { url: 'https://test.com/2', title: 'Job 2', workmode: 'ON-SITE' },
          { url: 'https://test.com/3', title: 'Job 3', workmode: 'Hybrid' },
          { url: 'https://test.com/4', title: 'Job 4', workmode: 'hybrid' }
        ]
      };

      const result = index.transformJobsForSOLR(payload);

      expect(result.jobs[0].workmode).toBe('remote');
      expect(result.jobs[1].workmode).toBe('on-site');
      expect(result.jobs[2].workmode).toBe('hybrid');
      expect(result.jobs[3].workmode).toBe('hybrid');
    });

    it('should handle empty jobs array', () => {
      const result = index.transformJobsForSOLR({ jobs: [] });
      expect(result.jobs).toEqual([]);
    });
  });

  describe('mapToJobModel', () => {
    it('should map raw job to job model format', () => {
      const rawJob = {
        url: 'https://careers.wizzair.com/job/123',
        title: 'Senior Developer',
        location: ['Bucharest'],
        tags: ['Java', 'Spring'],
        workmode: 'hybrid'
      };

      const COMPANY_NAME = 'WIZZ AIR MALTA LIMITED LUQA - SUCURSALA OTOPENI';
      const COMPANY_CIF = '46966293';

      const result = index.mapToJobModel(rawJob, COMPANY_CIF, COMPANY_NAME);

      expect(result.url).toBe(rawJob.url);
      expect(result.title).toBe(rawJob.title);
      expect(result.company).toBe(COMPANY_NAME);
      expect(result.cif).toBe(COMPANY_CIF);
      expect(result.location).toEqual(rawJob.location);
      expect(result.tags).toEqual(rawJob.tags);
      expect(result.workmode).toBe(rawJob.workmode);
      expect(result.status).toBe('scraped');
      expect(result.date).toBeDefined();
    });

    it('should remove undefined fields', () => {
      const rawJob = {
        url: 'https://test.com/1',
        title: 'Job 1'
      };

      const result = index.mapToJobModel(rawJob, '46966293');

      expect(result.location).toBeUndefined();
      expect(result.tags).toBeUndefined();
      expect(result.workmode).toBeUndefined();
    });

    it('should handle missing title', () => {
      const rawJob = { url: 'https://test.com/1' };

      const result = index.mapToJobModel(rawJob, '46966293');

      expect(result.title).toBeUndefined();
      expect(result.url).toBe('https://test.com/1');
    });
  });

  describe('parseSitemap', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://careers.wizzair.com/job/Otopeni-Fleet-Manager-75100/1437612933/</loc></url>
      <url><loc>https://careers.wizzair.com/job/Budapest-Pilot-1000/111/</loc></url>
      <url><loc>https://careers.wizzair.com/job/Budapest-Pilot-1000/111/</loc></url>
      <url><loc>https://careers.wizzair.com/go/Pilot-Jobs/5258601/</loc></url>
    </urlset>`;

    it('extracts unique job URLs only', () => {
      expect(index.parseSitemap(xml)).toEqual([
        'https://careers.wizzair.com/job/Otopeni-Fleet-Manager-75100/1437612933/',
        'https://careers.wizzair.com/job/Budapest-Pilot-1000/111/'
      ]);
    });

    it('returns an empty list for empty or broken input', () => {
      expect(index.parseSitemap('')).toEqual([]);
      expect(index.parseSitemap(undefined)).toEqual([]);
      expect(index.parseSitemap('<html>blocked</html>')).toEqual([]);
    });
  });

  describe('parseJobPage', () => {
    const page = `<html><head>
      <title>Fleet Manager Job Details | Wizz Air Hungary Ltd.</title>
      <link rel="canonical" href="https://careers.wizzair.com/job/Otopeni-Fleet-Manager-75100/1437612933/" />
      <meta itemprop="datePosted" content="Wed Sep 16 00:00:00 UTC 2026">
      </head><body><h1 itemprop="title">Fleet Manager</h1>
      <span class="jobGeoLocation">Otopeni, RO, 75100</span></body></html>`;

    it('reads title, city, country and canonical url', () => {
      const job = index.parseJobPage(page, 'https://careers.wizzair.com/job/x/1/');
      expect(job.title).toBe('Fleet Manager');
      expect(job.city).toBe('Otopeni');
      expect(job.country).toBe('RO');
      expect(job.url).toBe('https://careers.wizzair.com/job/Otopeni-Fleet-Manager-75100/1437612933/');
      expect(job.datePosted).toContain('2026');
    });

    it('falls back to <title> and the address meta when the main selectors are missing', () => {
      const html = `<html><head><title>Cabin Crew Job Details | Wizz Air Hungary Ltd.</title>
        <meta itemprop="streetAddress" content="Cluj-Napoca, ro, 400000"></head><body></body></html>`;
      const job = index.parseJobPage(html, 'https://careers.wizzair.com/job/y/2/');
      expect(job.title).toBe('Cabin Crew');
      expect(job.city).toBe('Cluj-Napoca');
      expect(job.country).toBe('RO');
      expect(job.url).toBe('https://careers.wizzair.com/job/y/2/');
    });

    it('keeps non-Romanian jobs identifiable so the scraper can drop them', () => {
      const html = '<h1>Pilot</h1><span class="jobGeoLocation">Budapest, HU, 1000</span>';
      expect(index.parseJobPage(html, 'u').country).toBe('HU');
    });

    it('returns null when there is no title at all', () => {
      expect(index.parseJobPage('<html><body>blocked</body></html>', 'u')).toBeNull();
      expect(index.parseJobPage('', 'u')).toBeNull();
    });
  });
});