export const CHURN_MANIFEST_SCHEMA = "com.dodefey.churn-manifest"
export const CHURN_MANIFEST_SCHEMA_MAJOR = 2
export const CHURN_MANIFEST_SCHEMA_VERSION = "2.0.0"

export const CHURN_REPORT_SCHEMA = "com.dodefey.churn-report"
export const CHURN_REPORT_SCHEMA_MAJOR = 1
export const CHURN_REPORT_SCHEMA_VERSION = "1.0.0"
export const CHURN_REPORT_METRIC_SET_VERSION = "core-1"

export interface TChurnManifestV2File {
	path: string
	size: number
	sha256: string
	assetType: string
	ownerGroup: string
}

export interface TChurnManifestV2 {
	schema: typeof CHURN_MANIFEST_SCHEMA
	schemaVersion: string
	generatedAt: string
	root: string
	files: TChurnManifestV2File[]
}

export interface TChurnReportProducer {
	name: string
	version: string
}

export interface TChurnReportRun {
	profile: string
	mode: string
	dryRun: boolean
}

export interface TChurnReportBaseline {
	available: boolean
	kind: string
	distance: number
}

export interface TChurnReportCapabilities {
	hashDiff: boolean
	renameDetection: string
	assetTyping: string
	ownerGrouping: string
}

export interface TChurnReportCoreFiles {
	totalOld: number
	totalNew: number
	stable: number
	changed: number
	added: number
	removed: number
}

export interface TChurnReportCoreBytes {
	totalOld: number
	totalNew: number
	stable: number
	changed: number
	added: number
	removed: number
}

export interface TChurnReportCorePercent {
	downloadImpactFiles: number
	cacheReuseFiles: number
	downloadImpactBytes: number
	cacheReuseBytes: number
}

export interface TChurnReportCore {
	files: TChurnReportCoreFiles
	bytes: TChurnReportCoreBytes
	percent: TChurnReportCorePercent
}

export interface TChurnCategoryTotals {
	files: number
	bytes: number
}

export interface TChurnDiagnosticsCategories {
	reused_exact?: TChurnCategoryTotals
	changed_same_path?: TChurnCategoryTotals
	renamed_same_hash?: TChurnCategoryTotals
	new_content?: TChurnCategoryTotals
	removed?: TChurnCategoryTotals
}

export interface TChurnAvoidableChurn {
	renameNoiseBytes: number
	renameNoisePercentOfDownloadBytes: number
}

export interface TChurnOffender {
	path: string
	bytes: number
	assetType?: string
	ownerGroup?: string
}

export interface TChurnTopOffenders {
	newContentByBytes?: TChurnOffender[]
	changedSamePathByBytes?: TChurnOffender[]
	renamedSameHashByBytes?: TChurnOffender[]
}

export interface TChurnAttributionBucket {
	key: string
	files: number
	bytes: number
}

export interface TChurnAttribution {
	byAssetType?: TChurnAttributionBucket[]
	byOwnerGroup?: TChurnAttributionBucket[]
	unknownOwnerBytes?: number
}

export interface TChurnReportDiagnostics {
	categories: TChurnDiagnosticsCategories
	avoidableChurn?: TChurnAvoidableChurn
	topOffenders?: TChurnTopOffenders
	attribution?: TChurnAttribution
	recommendations?: string[]
}

export interface TChurnReportQuality {
	comparableClass: string
	warnings: string[]
}

export interface TChurnReportV1 {
	schema: typeof CHURN_REPORT_SCHEMA
	schemaVersion: string
	metricSetVersion: string
	reportId: string
	generatedAt: string
	producer: TChurnReportProducer
	run: TChurnReportRun
	baseline: TChurnReportBaseline
	capabilities: TChurnReportCapabilities
	core: TChurnReportCore
	diagnostics?: TChurnReportDiagnostics
	quality: TChurnReportQuality
}

type TRecord = Record<string, unknown>

function isRecord(value: unknown): value is TRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): TRecord {
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`)
	}
	return value
}

function readString(obj: TRecord, key: string, label: string): string {
	const value = obj[key]
	if (typeof value !== "string") {
		throw new Error(`${label}.${key} must be a string`)
	}
	return value
}

function readFiniteNumber(obj: TRecord, key: string, label: string): number {
	const value = obj[key]
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label}.${key} must be a finite number`)
	}
	return value
}

function readBoolean(obj: TRecord, key: string, label: string): boolean {
	const value = obj[key]
	if (typeof value !== "boolean") {
		throw new Error(`${label}.${key} must be a boolean`)
	}
	return value
}

function readArray(obj: TRecord, key: string, label: string): unknown[] {
	const value = obj[key]
	if (!Array.isArray(value)) {
		throw new Error(`${label}.${key} must be an array`)
	}
	return value
}

function requireCompatibleMajorVersion(
	version: string,
	expectedMajor: number,
	label: string,
): void {
	const [majorRaw] = version.split(".")
	const major = Number(majorRaw)
	if (!Number.isInteger(major) || major !== expectedMajor) {
		throw new Error(
			`${label} must use major version ${String(expectedMajor)} (received "${version}")`,
		)
	}
}

function parseManifestFile(
	value: unknown,
	label: string,
): TChurnManifestV2File {
	const obj = requireRecord(value, label)
	return {
		path: readString(obj, "path", label),
		size: readFiniteNumber(obj, "size", label),
		sha256: readString(obj, "sha256", label),
		assetType: readString(obj, "assetType", label),
		ownerGroup: readString(obj, "ownerGroup", label),
	}
}

function parseCategoryTotals(
	value: unknown,
	label: string,
): TChurnCategoryTotals {
	const obj = requireRecord(value, label)
	return {
		files: readFiniteNumber(obj, "files", label),
		bytes: readFiniteNumber(obj, "bytes", label),
	}
}

function parseOffender(value: unknown, label: string): TChurnOffender {
	const obj = requireRecord(value, label)
	const path = readString(obj, "path", label)
	const bytes = readFiniteNumber(obj, "bytes", label)
	const assetType =
		typeof obj.assetType === "string" ? obj.assetType : undefined
	const ownerGroup =
		typeof obj.ownerGroup === "string" ? obj.ownerGroup : undefined

	return { path, bytes, assetType, ownerGroup }
}

function parseAttributionBucket(
	value: unknown,
	label: string,
): TChurnAttributionBucket {
	const obj = requireRecord(value, label)
	return {
		key: readString(obj, "key", label),
		files: readFiniteNumber(obj, "files", label),
		bytes: readFiniteNumber(obj, "bytes", label),
	}
}

export function parseChurnManifestV2(value: unknown): TChurnManifestV2 {
	const root = requireRecord(value, "manifest")
	const schema = readString(root, "schema", "manifest")
	if (schema !== CHURN_MANIFEST_SCHEMA) {
		throw new Error(
			`manifest.schema must be "${CHURN_MANIFEST_SCHEMA}" (received "${schema}")`,
		)
	}

	const schemaVersion = readString(root, "schemaVersion", "manifest")
	requireCompatibleMajorVersion(
		schemaVersion,
		CHURN_MANIFEST_SCHEMA_MAJOR,
		"manifest.schemaVersion",
	)

	const generatedAt = readString(root, "generatedAt", "manifest")
	const manifestRoot = readString(root, "root", "manifest")
	const filesRaw = readArray(root, "files", "manifest")
	const files = filesRaw.map((entry, index) =>
		parseManifestFile(entry, `manifest.files[${String(index)}]`),
	)

	return {
		schema: CHURN_MANIFEST_SCHEMA,
		schemaVersion,
		generatedAt,
		root: manifestRoot,
		files,
	}
}

export function parseChurnManifestV2Json(content: string): TChurnManifestV2 {
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch (err) {
		throw new Error(
			`Failed to parse churn manifest JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		)
	}
	return parseChurnManifestV2(parsed)
}

export function parseChurnReportV1(value: unknown): TChurnReportV1 {
	const root = requireRecord(value, "report")
	const schema = readString(root, "schema", "report")
	if (schema !== CHURN_REPORT_SCHEMA) {
		throw new Error(
			`report.schema must be "${CHURN_REPORT_SCHEMA}" (received "${schema}")`,
		)
	}

	const schemaVersion = readString(root, "schemaVersion", "report")
	requireCompatibleMajorVersion(
		schemaVersion,
		CHURN_REPORT_SCHEMA_MAJOR,
		"report.schemaVersion",
	)

	const metricSetVersion = readString(root, "metricSetVersion", "report")
	const reportId = readString(root, "reportId", "report")
	const generatedAt = readString(root, "generatedAt", "report")

	const producerObj = requireRecord(root.producer, "report.producer")
	const producer: TChurnReportProducer = {
		name: readString(producerObj, "name", "report.producer"),
		version: readString(producerObj, "version", "report.producer"),
	}

	const runObj = requireRecord(root.run, "report.run")
	const run: TChurnReportRun = {
		profile: readString(runObj, "profile", "report.run"),
		mode: readString(runObj, "mode", "report.run"),
		dryRun: readBoolean(runObj, "dryRun", "report.run"),
	}

	const baselineObj = requireRecord(root.baseline, "report.baseline")
	const baseline: TChurnReportBaseline = {
		available: readBoolean(baselineObj, "available", "report.baseline"),
		kind: readString(baselineObj, "kind", "report.baseline"),
		distance: readFiniteNumber(baselineObj, "distance", "report.baseline"),
	}

	const capabilitiesObj = requireRecord(
		root.capabilities,
		"report.capabilities",
	)
	const capabilities: TChurnReportCapabilities = {
		hashDiff: readBoolean(capabilitiesObj, "hashDiff", "report.capabilities"),
		renameDetection: readString(
			capabilitiesObj,
			"renameDetection",
			"report.capabilities",
		),
		assetTyping: readString(
			capabilitiesObj,
			"assetTyping",
			"report.capabilities",
		),
		ownerGrouping: readString(
			capabilitiesObj,
			"ownerGrouping",
			"report.capabilities",
		),
	}

	const coreObj = requireRecord(root.core, "report.core")
	const coreFilesObj = requireRecord(coreObj.files, "report.core.files")
	const coreBytesObj = requireRecord(coreObj.bytes, "report.core.bytes")
	const corePercentObj = requireRecord(
		coreObj.percent,
		"report.core.percent",
	)

	const core: TChurnReportCore = {
		files: {
			totalOld: readFiniteNumber(coreFilesObj, "totalOld", "report.core.files"),
			totalNew: readFiniteNumber(coreFilesObj, "totalNew", "report.core.files"),
			stable: readFiniteNumber(coreFilesObj, "stable", "report.core.files"),
			changed: readFiniteNumber(coreFilesObj, "changed", "report.core.files"),
			added: readFiniteNumber(coreFilesObj, "added", "report.core.files"),
			removed: readFiniteNumber(coreFilesObj, "removed", "report.core.files"),
		},
		bytes: {
			totalOld: readFiniteNumber(coreBytesObj, "totalOld", "report.core.bytes"),
			totalNew: readFiniteNumber(coreBytesObj, "totalNew", "report.core.bytes"),
			stable: readFiniteNumber(coreBytesObj, "stable", "report.core.bytes"),
			changed: readFiniteNumber(coreBytesObj, "changed", "report.core.bytes"),
			added: readFiniteNumber(coreBytesObj, "added", "report.core.bytes"),
			removed: readFiniteNumber(coreBytesObj, "removed", "report.core.bytes"),
		},
		percent: {
			downloadImpactFiles: readFiniteNumber(
				corePercentObj,
				"downloadImpactFiles",
				"report.core.percent",
			),
			cacheReuseFiles: readFiniteNumber(
				corePercentObj,
				"cacheReuseFiles",
				"report.core.percent",
			),
			downloadImpactBytes: readFiniteNumber(
				corePercentObj,
				"downloadImpactBytes",
				"report.core.percent",
			),
			cacheReuseBytes: readFiniteNumber(
				corePercentObj,
				"cacheReuseBytes",
				"report.core.percent",
			),
		},
	}

	let diagnostics: TChurnReportDiagnostics | undefined
	if (root.diagnostics !== undefined) {
		const diagnosticsObj = requireRecord(root.diagnostics, "report.diagnostics")
		const categoriesObj = requireRecord(
			diagnosticsObj.categories,
			"report.diagnostics.categories",
		)
		const categories: TChurnDiagnosticsCategories = {}
		if (categoriesObj.reused_exact !== undefined) {
			categories.reused_exact = parseCategoryTotals(
				categoriesObj.reused_exact,
				"report.diagnostics.categories.reused_exact",
			)
		}
		if (categoriesObj.changed_same_path !== undefined) {
			categories.changed_same_path = parseCategoryTotals(
				categoriesObj.changed_same_path,
				"report.diagnostics.categories.changed_same_path",
			)
		}
		if (categoriesObj.renamed_same_hash !== undefined) {
			categories.renamed_same_hash = parseCategoryTotals(
				categoriesObj.renamed_same_hash,
				"report.diagnostics.categories.renamed_same_hash",
			)
		}
		if (categoriesObj.new_content !== undefined) {
			categories.new_content = parseCategoryTotals(
				categoriesObj.new_content,
				"report.diagnostics.categories.new_content",
			)
		}
		if (categoriesObj.removed !== undefined) {
			categories.removed = parseCategoryTotals(
				categoriesObj.removed,
				"report.diagnostics.categories.removed",
			)
		}

		let avoidableChurn: TChurnAvoidableChurn | undefined
		if (diagnosticsObj.avoidableChurn !== undefined) {
			const avoidableObj = requireRecord(
				diagnosticsObj.avoidableChurn,
				"report.diagnostics.avoidableChurn",
			)
			avoidableChurn = {
				renameNoiseBytes: readFiniteNumber(
					avoidableObj,
					"renameNoiseBytes",
					"report.diagnostics.avoidableChurn",
				),
				renameNoisePercentOfDownloadBytes: readFiniteNumber(
					avoidableObj,
					"renameNoisePercentOfDownloadBytes",
					"report.diagnostics.avoidableChurn",
				),
			}
		}

		let topOffenders: TChurnTopOffenders | undefined
		if (diagnosticsObj.topOffenders !== undefined) {
			const topObj = requireRecord(
				diagnosticsObj.topOffenders,
				"report.diagnostics.topOffenders",
			)
			const parseOffenderArray = (value: unknown, label: string) => {
				if (value === undefined) return undefined
				const arr = Array.isArray(value) ? value : null
				if (!arr) {
					throw new Error(`${label} must be an array`)
				}
				return arr.map((entry, index) =>
					parseOffender(entry, `${label}[${String(index)}]`),
				)
			}
			topOffenders = {
				newContentByBytes: parseOffenderArray(
					topObj.newContentByBytes,
					"report.diagnostics.topOffenders.newContentByBytes",
				),
				changedSamePathByBytes: parseOffenderArray(
					topObj.changedSamePathByBytes,
					"report.diagnostics.topOffenders.changedSamePathByBytes",
				),
				renamedSameHashByBytes: parseOffenderArray(
					topObj.renamedSameHashByBytes,
					"report.diagnostics.topOffenders.renamedSameHashByBytes",
				),
			}
		}

		let attribution: TChurnAttribution | undefined
		if (diagnosticsObj.attribution !== undefined) {
			const attributionObj = requireRecord(
				diagnosticsObj.attribution,
				"report.diagnostics.attribution",
			)
			const parseBucketArray = (value: unknown, label: string) => {
				if (value === undefined) return undefined
				const arr = Array.isArray(value) ? value : null
				if (!arr) {
					throw new Error(`${label} must be an array`)
				}
				return arr.map((entry, index) =>
					parseAttributionBucket(entry, `${label}[${String(index)}]`),
				)
			}
			attribution = {
				byAssetType: parseBucketArray(
					attributionObj.byAssetType,
					"report.diagnostics.attribution.byAssetType",
				),
				byOwnerGroup: parseBucketArray(
					attributionObj.byOwnerGroup,
					"report.diagnostics.attribution.byOwnerGroup",
				),
				unknownOwnerBytes:
					attributionObj.unknownOwnerBytes === undefined
						? undefined
						: readFiniteNumber(
								attributionObj,
								"unknownOwnerBytes",
								"report.diagnostics.attribution",
							),
			}
		}

		let recommendations: string[] | undefined
		if (diagnosticsObj.recommendations !== undefined) {
			const recommendationValues = readArray(
				diagnosticsObj,
				"recommendations",
				"report.diagnostics",
			)
			recommendations = recommendationValues.map((entry, index) => {
				if (typeof entry !== "string") {
					throw new Error(
						`report.diagnostics.recommendations[${String(index)}] must be a string`,
					)
				}
				return entry
			})
		}

		diagnostics = {
			categories,
			avoidableChurn,
			topOffenders,
			attribution,
			recommendations,
		}
	}

	const qualityObj = requireRecord(root.quality, "report.quality")
	const warnings = readArray(qualityObj, "warnings", "report.quality")
	const quality: TChurnReportQuality = {
		comparableClass: readString(qualityObj, "comparableClass", "report.quality"),
		warnings: warnings.map((entry, index) => {
			if (typeof entry !== "string") {
				throw new Error(
					`report.quality.warnings[${String(index)}] must be a string`,
				)
			}
			return entry
		}),
	}

	return {
		schema: CHURN_REPORT_SCHEMA,
		schemaVersion,
		metricSetVersion,
		reportId,
		generatedAt,
		producer,
		run,
		baseline,
		capabilities,
		core,
		diagnostics,
		quality,
	}
}

export function parseChurnReportV1Json(content: string): TChurnReportV1 {
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch (err) {
		throw new Error(
			`Failed to parse churn report JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		)
	}
	return parseChurnReportV1(parsed)
}
