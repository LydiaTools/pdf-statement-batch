/**
 * Base Parser - Shared Parsing Utilities
 * 
 * Common patterns and functions used across all bank-specific parsers.
 */

// Date patterns: MM/DD, MM/DD/YY, MM/DD/YYYY (simple pattern for quick checks)
const DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;
const DATE_IN_TEXT_PATTERN = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;

// Comprehensive date patterns supporting multiple formats and separators
// All parsers should import this single source of truth instead of defining their own.
// Supports: ISO, US, EU, compact, abbreviated month, and full month name formats.
const DATE_PATTERNS = [
    // ISO format: YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
    /^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/,

    // Common formats: DD/MM/YYYY, MM/DD/YYYY with various separators
    /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/,

    // Short format without year: DD/MM or MM/DD with various separators
    /^(\d{1,2})[\/\-\.](\d{1,2})$/,

    // Compact format without separators: DDMMYYYY or DDMMYY (8 or 6 digits)
    /^(\d{2})(\d{2})(\d{2,4})$/,

    // Month names with year: DD Mon YYYY, DD-Mon-YYYY (e.g., 15 Jan 2024, 1 Sept 2023)
    /^(\d{1,2})[\/\-\.\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[\/\-\.\s](\d{2,4})$/i,

    // Full month names with year: DD Month YYYY (e.g., 15 January 2024)
    /^(\d{1,2})[\/\-\.\s](January|February|March|April|May|June|July|August|September|October|November|December)[\/\-\.\s](\d{2,4})$/i,

    // Month names without year: DD Mon, DD-Mon (e.g., 1 Feb, 15-Jan)
    /^(\d{1,2})[\/\-\.\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)$/i,

    // Full month names without year: DD Month (e.g., 1 February, 15 January)
    /^(\d{1,2})[\/\-\.\s](January|February|March|April|May|June|July|August|September|October|November|December)$/i,

    // Mon DD, YYYY format (e.g., Jan 15, 2024)
    /^(\w{3,4})\s+(\d{1,2}),?\s*(\d{4})?$/,

    // Month/Year only: MM/YYYY or MM/YY (e.g., 05/2022)
    /^(\d{1,2})[\/\-](\d{4})$/
];

// Amount patterns: $1,234.56, -$1,234.56, €1,234.56, £1,234.56, 1234.56, -1234.56
const AMOUNT_PATTERN = /^-?[$€£¥₹]?[\d,]+\.\d{2}$/;
const AMOUNT_IN_TEXT_PATTERN = /-?[$€£¥₹]?([\d,]+\.\d{2})/g;

// Common section patterns for bank statements
const SECTION_PATTERNS = [
    { pattern: /DEPOSITS AND ADDITIONS/i, type: 'deposit', sign: 1 },
    { pattern: /ELECTRONIC WITHDRAWALS/i, type: 'withdrawal', sign: -1 },
    { pattern: /ATM & DEBIT CARD WITHDRAWALS/i, type: 'withdrawal', sign: -1 },
    { pattern: /WITHDRAWALS/i, type: 'withdrawal', sign: -1 },
    { pattern: /TRANSACTION DETAIL/i, type: 'mixed', sign: null },
    { pattern: /TRANSACTIONS/i, type: 'mixed', sign: null }
];

// Section end markers
const SECTION_END_PATTERNS = [
    /^Total\s/i,
    /^Ending Balance/i,
    /^Beginning Balance/i,
    /^\*end\*/i,
    /^IN CASE OF ERRORS/i,
    /^IMPORTANT NEWS/i,
    /^FINANCE CHARGES/i
];

// End-of-table marker patterns (generic across all banks)
// Used by position parser and rectangle parser to detect where a table ends.
// Designed to be bank-agnostic: matches "total" + any section keyword.
const END_OF_TABLE_PATTERNS = [
    // Generic "total [section]" patterns -- covers any bank's summary rows
    /^total\s+.*\b(deposits?|additions?|credits?)\b/i,
    /^total\s+.*\b(withdrawals?|debits?|charges?|payments?|subtractions?)\b/i,
    /^total\s+.*\b(transactions?|activity|items?)\b/i,
    /^total\s+.*\b(fees?|interest|adjustments?)\b/i,
    /^subtotal\b/i,

    // "Totals at end of page/period/statement" (ANZ, Commonwealth, etc.)
    /\btotals?\s+at\s+end\s+of\s+(page|period|statement)\b/i,

    // Balance-related end markers
    /\b(ending|closing|final)\s+balance\b/i,
    /\b(balance|bal\.?)\s+(brought|carried)\s+forward\b/i,

    // Page/footer markers (universal across all banks)
    /^page\s+\d+\s+of\s+\d+/i,
    /\bfacsimile\b/i,
    /^x\s+0+\d+/i,    // Footer codes like "x 0000001 ..."

    // Disclaimer / legal text markers
    /^in case of errors/i,
    /^important\s+(news|information|notice)/i,
    /^this\s+statement\s+is/i
];

/**
 * Parse a date string from various formats
 * 
 * @param {string} dateStr - Date string (MM/DD, MM/DD/YY, MM/DD/YYYY)
 * @returns {Object|null} Parsed date with month, day, year or null
 */
function parseDate(dateStr) {
    if (!dateStr) return null;
    
    const match = dateStr.trim().match(DATE_PATTERN);
    if (!match) return null;
    
    const [, month, day, year] = match;
    return {
        month: parseInt(month, 10),
        day: parseInt(day, 10),
        year: year ? (year.length === 2 ? 2000 + parseInt(year, 10) : parseInt(year, 10)) : null,
        raw: dateStr.trim()
    };
}

/**
 * Check if a string looks like a date
 * 
 * @param {string} str - String to check
 * @returns {boolean} True if string matches date pattern
 */
function isDate(str) {
    if (!str) return false;
    return DATE_PATTERN.test(str.trim());
}

/**
 * Parse an amount string to a number
 * 
 * @param {string} amountStr - Amount string ($1,234.56 or -1234.56)
 * @returns {number} Parsed amount
 */
function parseAmount(amountStr) {
    if (!amountStr) return 0;
    
    // Remove currency symbols and commas, preserve negative sign
    const cleaned = amountStr.replace(/[$€£¥₹₽₩₪฿₫₦₱₿¢,]/g, '').trim();
    const value = parseFloat(cleaned);
    
    return isNaN(value) ? 0 : value;
}

/**
 * Check if a string looks like an amount
 * 
 * @param {string} str - String to check
 * @returns {boolean} True if string matches amount pattern
 */
function isAmount(str) {
    if (!str) return false;
    return AMOUNT_PATTERN.test(str.replace(/[$€£¥₹₽₩₪฿₫₦₱₿¢,]/g, '').trim());
}

/**
 * Extract all amounts from a text string
 * 
 * @param {string} text - Text to search
 * @returns {Array<string>} Array of amount strings found
 */
function extractAmounts(text) {
    if (!text) return [];
    const matches = text.match(AMOUNT_IN_TEXT_PATTERN);
    return matches || [];
}

/**
 * Find sections in the extracted text
 * 
 * @param {string} text - Full extracted text
 * @returns {Array<Object>} Array of section objects with type, index, and name
 */
function findSections(text) {
    const sections = [];
    
    for (const { pattern, type, sign } of SECTION_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            sections.push({
                type,
                sign,
                index: match.index,
                name: match[0],
                endIndex: null  // Will be calculated later
            });
        }
    }
    
    // Sort by position in document
    sections.sort((a, b) => a.index - b.index);
    
    // Calculate end indices based on next section
    for (let i = 0; i < sections.length; i++) {
        if (i < sections.length - 1) {
            sections[i].endIndex = sections[i + 1].index;
        } else {
            sections[i].endIndex = text.length;
        }
    }
    
    return sections;
}

/**
 * Check if a line marks the end of a section
 * 
 * @param {string} line - Line to check
 * @returns {boolean} True if line is a section end marker
 */
function isSectionEnd(line) {
    return SECTION_END_PATTERNS.some(pattern => pattern.test(line.trim()));
}

/**
 * Split text into lines, filtering empty lines
 * 
 * @param {string} text - Text to split
 * @returns {Array<string>} Array of non-empty lines
 */
function splitLines(text) {
    if (!text) return [];
    return text.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * Clean and normalize a description string
 * 
 * @param {string} description - Raw description
 * @returns {string} Cleaned description
 */
function cleanDescription(description) {
    if (!description) return '';
    
    // Normalize whitespace
    let cleaned = description.replace(/\s+/g, ' ').trim();
    
    // Remove common noise patterns
    // cleaned = cleaned.replace(/\s+Card\s+\d{4}$/i, '');  // Remove trailing card numbers
    
    return cleaned;
}

/**
 * Merge multi-line description into single line
 * 
 * @param {Array<string>} lines - Array of description lines
 * @returns {string} Merged description
 */
function mergeDescription(lines) {
    return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract statement period from text
 * 
 * @param {string} text - Text to search
 * @returns {Object|null} Period object with startDate and endDate
 */
function extractStatementPeriod(text) {
    // Pattern: "Month DD, YYYY through Month DD, YYYY"
    const throughPattern = /(\w+\s+\d{1,2},\s*\d{4})\s+through\s+(\w+\s+\d{1,2},\s*\d{4})/i;
    let match = text.match(throughPattern);
    if (match) {
        return {
            startDate: match[1],
            endDate: match[2],
            raw: match[0]
        };
    }
    
    // Pattern: "MM/DD/YY - MM/DD/YY" or "MM/DD/YYYY - MM/DD/YYYY"
    const dashPattern = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/;
    match = text.match(dashPattern);
    if (match) {
        return {
            startDate: match[1],
            endDate: match[2],
            raw: match[0]
        };
    }
    
    // Pattern: "Opening/Closing Date: MM/DD/YY - MM/DD/YY"
    const openClosePattern = /Opening\/Closing Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i;
    match = text.match(openClosePattern);
    if (match) {
        return {
            startDate: match[1],
            endDate: match[2],
            raw: match[0]
        };
    }
    
    return null;
}

/**
 * Check if a line looks like a transaction row start
 * 
 * @param {string} line - Line to check
 * @returns {boolean} True if line starts with a date
 */
function isTransactionStart(line) {
    if (!line) return false;
    const firstWord = line.trim().split(/\s+/)[0];
    return isDate(firstWord);
}

/**
 * Check if a line is a continuation of previous transaction
 * 
 * @param {string} line - Line to check
 * @returns {boolean} True if line appears to be a continuation
 */
function isContinuation(line) {
    if (!line) return false;
    const trimmed = line.trim();
    
    // Not a continuation if empty or starts with date
    if (!trimmed || isTransactionStart(trimmed)) return false;
    
    // Not a continuation if it's a section header or end marker
    if (isSectionEnd(trimmed)) return false;
    
    // Check if it's a common section header
    if (SECTION_PATTERNS.some(({ pattern }) => pattern.test(trimmed))) return false;
    
    return true;
}

/**
 * Create a result object for parser output
 * 
 * @param {boolean} success - Whether parsing succeeded
 * @param {Array} transactions - Parsed transactions
 * @param {Array} headers - Column headers
 * @param {Object} metadata - Additional metadata
 * @param {string} error - Error message if failed
 * @returns {Object} Standardized parser result
 */
function createResult(success, transactions = [], headers = [], metadata = {}, error = null) {
    return {
        success,
        transactions,
        headers,
        metadata,
        error
    };
}

/**
 * Format an amount/balance value for clean CSV output
 * 
 * Rules:
 * - If the value contains any letters (including DR, CR), return as-is
 * - If the value only has digits, money symbols, commas, dots, and spaces:
 *   remove spacing, remove commas, remove currency symbols
 * 
 * @param {*} value - Amount or balance value to format
 * @returns {string} Formatted value for CSV
 */
function formatAmountForCSV(value) {
    if (value == null || value === '') return '';
    
    const str = String(value).trim();
    
    // If empty after trim, return empty
    if (!str) return '';
    
    // If contains any letters (a-z, A-Z), don't format - return as is
    // This preserves values like "1,234.56 CR" or "45.00 DR"
    if (/[a-zA-Z]/.test(str)) {
        return str;
    }
    
    // Value only contains digits, symbols, spaces - format it
    // Remove: spaces, commas, and common currency symbols
    const cleaned = str
        .replace(/[\s,]/g, '')                   // Remove spaces and commas
        .replace(/[$€£¥₹₽₩₪฿₫₦₱₿¢]/g, '');     // Remove currency symbols
    
    return cleaned;
}

// ─── Confidence Scoring ────────────────────────────────────────────────────
// Weights for each confidence factor (must sum to 1.0)
const CONFIDENCE_WEIGHTS = {
    datePresence: 0.30,    // % of rows with a valid date
    amountPresence: 0.25,  // % of rows with a parseable amount
    headerQuality: 0.20,   // Were real headers detected vs inferred?
    parserTier: 0.15,      // Rectangle > Position > Text
    columnConsistency: 0.10 // Do most rows have the same filled columns?
};

/**
 * Check if a header name represents an amount/monetary column.
 * Handles space-corrupted names (e.g. "W ITHDRAWAL") by normalizing spaces.
 *
 * @param {string} headerName - Header text to check
 * @returns {boolean} True if this looks like an amount column
 */
function isAmountHeader(headerName) {
    if (!headerName) return false;
    const h = headerName.trim();
    // Check original and space-collapsed versions
    const normalized = h.replace(/\s+/g, '').toLowerCase();
    const lower = h.toLowerCase();

    // Exact standalone matches (case-insensitive), with optional currency prefix
    if (/^[£$€¥₹]?\s*(in|out|dr|cr)$/i.test(h)) return true;

    // Strip currency symbols for matching
    const stripped = lower.replace(/[£$€¥₹₽₩₪฿₫₦₱₿¢()]/g, '').trim();
    const strippedNorm = stripped.replace(/\s+/g, '');

    // Pattern matching on both original and space-collapsed
    const amountRe = /amount|deposit|withdrawal|credit|debit|charges?|payments?|money\s*(?:out|in)|paid\s*(?:out|in)|(?:^|\b)(?:in|out|dr|cr)(?:\b|$)/i;
    if (amountRe.test(lower)) return true;
    if (amountRe.test(normalized)) return true;
    if (amountRe.test(stripped)) return true;
    if (amountRe.test(strippedNorm)) return true;

    // Also match currency-suffixed variants like "AMOUNT(RS.)" or "PAID IN(£)"
    if (/amount|deposit|withdrawal|credit|debit/i.test(normalized)) return true;

    return false;
}

/**
 * Compute a confidence score (0-1.0) for a parser result
 * 
 * Evaluates multiple quality signals to produce a single confidence number.
 * Higher is better. Useful for UI warnings ("Low confidence - please verify").
 * 
 * @param {Object} result - Parser result from createResult()
 * @returns {number} Confidence score between 0 and 1.0
 */
function computeConfidence(result) {
    if (!result || !result.success || result.transactions.length === 0) return 0;
    
    const { transactions, headers, metadata } = result;
    const totalRows = transactions.length;
    
    // Factor 1: Date presence -- how many rows have a date-like value?
    let dateHits = 0;
    const dateHeader = headers.find(h => /date/i.test(h)) || headers[0];
    for (const tx of transactions) {
        const dateVal = tx[dateHeader] || tx.date || '';
        const dateStr = String(dateVal).trim();
        // Test both the original (with spaces as separators) and collapsed (for numeric-only dates)
        if (DATE_PATTERNS.some(p => p.test(dateStr) || p.test(dateStr.replace(/\s+/g, '')))) {
            dateHits++;
        }
    }
    const dateScore = totalRows > 0 ? dateHits / totalRows : 0;
    
    // Factor 2: Amount presence -- how many rows have a parseable amount?
    let amountHits = 0;
    const amountHeaders = headers.filter(h => isAmountHeader(h));
    for (const tx of transactions) {
        let hasAmount = false;
        // Check named amount columns
        for (const hdr of amountHeaders) {
            const val = String(tx[hdr] || '').replace(/[$€£¥₹₽₩₪฿₫₦₱₿¢,\s]/g, '');
            if (/^\d+(\.\d+)?$/.test(val) || /^-\d+(\.\d+)?$/.test(val)) {
                hasAmount = true;
                break;
            }
        }
        // Fallback: check .amount property
        if (!hasAmount && tx.amount != null && tx.amount !== 0) hasAmount = true;
        if (hasAmount) amountHits++;
    }
    const amountScore = totalRows > 0 ? amountHits / totalRows : 0;
    
    // Factor 3: Header quality -- real names vs COL_N / generic
    const genericHeaderCount = headers.filter(h => /^COL_\d+$/.test(h)).length;
    const headerScore = headers.length > 0
        ? 1 - (genericHeaderCount / headers.length)
        : 0;
    
    // Factor 4: Parser tier -- rectangle > position > text
    const parserType = (metadata && metadata.parserType) || 'text-based';
    const tierScores = { 'rectangle-based': 1.0, 'position-based': 0.8, 'text-based': 0.4 };
    const tierScore = tierScores[parserType] || 0.4;
    
    // Factor 5: Column consistency -- do most rows have the same filled column count?
    const filledCounts = transactions.map(tx => {
        return headers.filter(h => {
            const v = tx[h];
            return v != null && String(v).trim().length > 0;
        }).length;
    });
    if (filledCounts.length > 0) {
        // Mode of filled counts
        const countMap = {};
        for (const c of filledCounts) countMap[c] = (countMap[c] || 0) + 1;
        const modeCount = Math.max(...Object.values(countMap));
        var consistencyScore = modeCount / totalRows;
    } else {
        var consistencyScore = 0;
    }
    
    // Weighted sum
    const confidence =
        CONFIDENCE_WEIGHTS.datePresence * dateScore +
        CONFIDENCE_WEIGHTS.amountPresence * amountScore +
        CONFIDENCE_WEIGHTS.headerQuality * headerScore +
        CONFIDENCE_WEIGHTS.parserTier * tierScore +
        CONFIDENCE_WEIGHTS.columnConsistency * consistencyScore;
    
    return Math.round(confidence * 100) / 100; // 2 decimal places
}

// ─── Post-Parsing Validation ───────────────────────────────────────────────

/**
 * Validate parsed transactions and return warnings/issues
 * 
 * Runs a set of heuristic checks on the parsed output to flag potential
 * problems without modifying the data. Warnings are informational only.
 * 
 * @param {Object} result - Parser result from createResult()
 * @returns {Array<Object>} Array of warning objects { type, message, details }
 */
function validateTransactions(result) {
    if (!result || !result.success || result.transactions.length === 0) return [];
    
    const warnings = [];
    const { transactions, headers } = result;
    
    // Check 1: Duplicate detection
    const seen = new Map();
    const duplicates = [];
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        // Build a key from date + description + first amount
        const dateVal = tx.date || tx[headers[0]] || '';
        const descVal = tx.description || tx[headers[1]] || '';
        const amountVal = String(tx.amount || tx[headers[2]] || '');
        const key = `${dateVal}|${descVal}|${amountVal}`.toLowerCase();
        
        if (seen.has(key)) {
            duplicates.push({ row: i + 1, matchesRow: seen.get(key) + 1 });
        } else {
            seen.set(key, i);
        }
    }
    if (duplicates.length > 0) {
        warnings.push({
            type: 'duplicates',
            message: `${duplicates.length} potential duplicate transaction(s) detected`,
            details: duplicates.slice(0, 5) // Show first 5
        });
    }
    
    // Check 2: Empty column detection -- warn if any column is empty in >50% of rows
    for (const header of headers) {
        let emptyCount = 0;
        for (const tx of transactions) {
            const val = tx[header];
            if (val == null || String(val).trim() === '') emptyCount++;
        }
        const emptyRatio = emptyCount / transactions.length;
        if (emptyRatio > 0.5 && transactions.length >= 3) {
            warnings.push({
                type: 'empty_column',
                message: `Column "${header}" is empty in ${Math.round(emptyRatio * 100)}% of rows -- possible column misalignment`,
                details: { header, emptyRatio: Math.round(emptyRatio * 100) }
            });
        }
    }
    
    // Check 3: Running balance consistency (if balance column exists)
    const balanceHeader = headers.find(h => /balance/i.test(h));
    const amountHeader = headers.find(h => /^amount$/i.test(h));
    if (balanceHeader && amountHeader) {
        let inconsistencies = 0;
        for (let i = 1; i < transactions.length; i++) {
            const prevBal = parseAmount(String(transactions[i - 1][balanceHeader] || ''));
            const curBal = parseAmount(String(transactions[i][balanceHeader] || ''));
            const amount = parseAmount(String(transactions[i][amountHeader] || ''));
            
            if (prevBal !== 0 && curBal !== 0 && amount !== 0) {
                const expected = Math.round((prevBal + amount) * 100) / 100;
                const actual = Math.round(curBal * 100) / 100;
                if (Math.abs(expected - actual) > 0.01) {
                    inconsistencies++;
                }
            }
        }
        if (inconsistencies > 0) {
            warnings.push({
                type: 'balance_mismatch',
                message: `${inconsistencies} row(s) where running balance doesn't match (prev + amount != balance)`,
                details: { inconsistencies, total: transactions.length - 1 }
            });
        }
    }
    
    return warnings;
}

export {
    // Patterns
    DATE_PATTERN,
    DATE_IN_TEXT_PATTERN,
    DATE_PATTERNS,
    AMOUNT_PATTERN,
    AMOUNT_IN_TEXT_PATTERN,
    SECTION_PATTERNS,
    SECTION_END_PATTERNS,
    END_OF_TABLE_PATTERNS,
    
    // Date functions
    parseDate,
    isDate,
    
    // Amount functions
    parseAmount,
    isAmount,
    extractAmounts,
    formatAmountForCSV,
    
    // Section functions
    findSections,
    isSectionEnd,
    
    // Text functions
    splitLines,
    cleanDescription,
    mergeDescription,
    
    // Transaction helpers
    isTransactionStart,
    isContinuation,
    extractStatementPeriod,
    
    // Result helpers
    createResult,
    
    // Quality assessment
    computeConfidence,
    validateTransactions,
    isAmountHeader
};
