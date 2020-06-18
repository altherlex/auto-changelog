const { Command } = require('commander')
const semver = require('semver')
const { version } = require('../package.json')
const { fetchRemote } = require('./remote')
const { fetchTags } = require('./tags')
const { parseReleases } = require('./releases')
const { compileTemplate } = require('./template')
const { parseLimit, readFile, readJson, writeFile, fileExists, updateLog, formatBytes, parseAzureResponse} = require('./utils')
const fetch = require('node-fetch')
const { Headers } = require('node-fetch');
var base64 = require('base-64')

const DEFAULT_OPTIONS = {
  output: 'CHANGELOG.md',
  template: 'compact',
  remote: 'origin',
  commitLimit: 3,
  backfillLimit: 3,
  tagPrefix: '',
  sortCommits: 'relevance',
  appendGitLog: '',
  config: '.auto-changelog'
}

const PACKAGE_FILE = 'package.json'
const PACKAGE_OPTIONS_KEY = 'auto-changelog'
const PREPEND_TOKEN = '<!-- auto-changelog-above -->'

async function getOptions (argv) {
  const options = new Command()
    .option('--input <file>', 'inform a release.json source pre-processed')
    .option('--azure-api <source>', 'inform azure pull request end')
    .option('--azure-user <source>', 'inform username:password')
    .option('-o, --output <file>', `output file, default: ${DEFAULT_OPTIONS.output}`)
    .option('-c, --config <file>', `config file location, default: ${DEFAULT_OPTIONS.config}`)
    .option('-t, --template <template>', `specify template to use [compact, keepachangelog, json], default: ${DEFAULT_OPTIONS.template}`)
    .option('-r, --remote <remote>', `specify git remote to use for links, default: ${DEFAULT_OPTIONS.remote}`)
    .option('-p, --package [file]', 'use version from file as latest release, default: package.json')
    .option('-v, --latest-version <version>', 'use specified version as latest release')
    .option('-u, --unreleased', 'include section for unreleased changes')
    .option('-l, --commit-limit <count>', `number of commits to display per release, default: ${DEFAULT_OPTIONS.commitLimit}`, parseLimit)
    .option('-b, --backfill-limit <count>', `number of commits to backfill empty releases with, default: ${DEFAULT_OPTIONS.backfillLimit}`, parseLimit)
    .option('--commit-url <url>', 'override url for commits, use {id} for commit id')
    .option('-i, --issue-url <url>', 'override url for issues, use {id} for issue id') // -i kept for back compatibility
    .option('--merge-url <url>', 'override url for merges, use {id} for merge id')
    .option('--compare-url <url>', 'override url for compares, use {from} and {to} for tags')
    .option('--issue-pattern <regex>', 'override regex pattern for issues in commit messages')
    .option('--breaking-pattern <regex>', 'regex pattern for breaking change commits')
    .option('--merge-pattern <regex>', 'add custom regex pattern for merge commits')
    .option('--ignore-commit-pattern <regex>', 'pattern to ignore when parsing commits')
    .option('--tag-pattern <regex>', 'override regex pattern for version tags')
    .option('--tag-prefix <prefix>', 'prefix used in version tags')
    .option('--starting-version <tag>', 'specify earliest version to include in changelog')
    .option('--sort-commits <property>', `sort commits by property [relevance, date, date-desc], default: ${DEFAULT_OPTIONS.sortCommits}`)
    .option('--release-summary', 'use tagged commit message body as release summary')
    .option('--unreleased-only', 'only output unreleased changes')
    .option('--hide-credit', 'hide auto-changelog credit')
    .option('--handlebars-setup <file>', 'handlebars setup file')
    .option('--append-git-log <string>', 'string to append to git log command')
    .option('--stdout', 'output changelog to stdout')
    .version(version)
    .parse(argv)

  const pkg = await readJson(PACKAGE_FILE)
  const packageOptions = pkg ? pkg[PACKAGE_OPTIONS_KEY] : null
  const dotOptions = await readJson(options.config || DEFAULT_OPTIONS.config)

  return {
    ...DEFAULT_OPTIONS,
    ...dotOptions,
    ...packageOptions,
    ...options
  }
}

async function getLatestVersion (options, tags) {
  if (options.latestVersion) {
    if (!semver.valid(options.latestVersion)) {
      throw new Error('--latest-version must be a valid semver version')
    }
    return options.latestVersion
  }
  if (options.package) {
    const file = options.package === true ? PACKAGE_FILE : options.package
    if (await fileExists(file) === false) {
      throw new Error(`File ${file} does not exist`)
    }
    const { version } = await readJson(file)
    const prefix = tags.some(({ tag }) => /^v/.test(tag)) ? 'v' : ''
    return `${prefix}${version}`
  }
  return null
}

async function formatAzureResponse(options) {
  let headers = new Headers()
  headers.append('Authorization', 'Basic ' + base64.encode(options.azureUser))
  const response = await fetch(options.azureApi, { headers: headers })

  const json = await response.json()
  // await writeFile('azure_reponse.json', JSON.stringify(json, null, 2))

  const releases = parseAzureResponse(json.value)
  await writeFile('./releases.json', JSON.stringify(releases, null, 2))

  return options
}

async function run (argv) {
  const options = await getOptions(argv)
  const log = string => options.stdout ? null : updateLog(string)

  let releases
  if (options.azureApi && options.azureUser) {
    await formatAzureResponse(options)
    releases = await readJson('./releases.json')
  } else if (options.input) {
    releases = await readJson(options.input)
  } else {
    log('Fetching remote…')
    const remote = await fetchRemote(options)
    log('Fetching tags…')
    const tags = await fetchTags(options)
    log(`${tags.length} version tags found…`)
    const latestVersion = await getLatestVersion(options, tags)
    const onParsed = ({ title }) => log(`Fetched ${title}…`)
    releases = await parseReleases(tags, remote, latestVersion, options, onParsed)
  }
  const changelog = await compileTemplate(options, { releases, options })
  await write(changelog, options, log)
}

async function write (changelog, options, log) {
  if (options.stdout) {
    process.stdout.write(changelog)
    return
  }
  const bytes = Buffer.byteLength(changelog, 'utf8')
  const existing = await fileExists(options.output) && await readFile(options.output, 'utf8')
  if (existing) {
    const index = existing.indexOf(PREPEND_TOKEN)
    if (index !== -1) {
      const prepended = `${changelog}\n${existing.slice(index)}`
      await writeFile(options.output, prepended)
      log(`${formatBytes(bytes)} prepended to ${options.output}\n`)
      return
    }
  }
  await writeFile(options.output, changelog)
  log(`${formatBytes(bytes)} written to ${options.output}\n`)
}

module.exports = {
  run
}
