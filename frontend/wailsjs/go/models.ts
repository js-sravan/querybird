export namespace models {
	
	export class ColumnInfo {
	    name: string;
	    type: string;
	    nullable: boolean;
	    default: string;
	    isGenerated: boolean;
	    isIdentity: boolean;
	    isPrimaryKey: boolean;
	    isForeignKey: boolean;
	    isUnique: boolean;
	    comment: string;
	    ordinal: number;
	
	    static createFrom(source: any = {}) {
	        return new ColumnInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.nullable = source["nullable"];
	        this.default = source["default"];
	        this.isGenerated = source["isGenerated"];
	        this.isIdentity = source["isIdentity"];
	        this.isPrimaryKey = source["isPrimaryKey"];
	        this.isForeignKey = source["isForeignKey"];
	        this.isUnique = source["isUnique"];
	        this.comment = source["comment"];
	        this.ordinal = source["ordinal"];
	    }
	}
	export class ConnectionConfig {
	    name: string;
	    host: string;
	    port: number;
	    database: string;
	    username: string;
	    password: string;
	    sslMode: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.database = source["database"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.sslMode = source["sslMode"];
	    }
	}
	export class ConnectionState {
	    name: string;
	    host: string;
	    port: number;
	    database: string;
	    username: string;
	    databases: string[];
	    schemas: string[];
	
	    static createFrom(source: any = {}) {
	        return new ConnectionState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.database = source["database"];
	        this.username = source["username"];
	        this.databases = source["databases"];
	        this.schemas = source["schemas"];
	    }
	}
	export class DatabaseObject {
	    name: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new DatabaseObject(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	    }
	}
	export class QueryResult {
	    columns: string[];
	    rows: any[];
	    rowCount: number;
	    affected: number;
	    executionMs: number;
	    success: boolean;
	    message: string;
	    truncatedColumns: string[];
	
	    static createFrom(source: any = {}) {
	        return new QueryResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = source["columns"];
	        this.rows = source["rows"];
	        this.rowCount = source["rowCount"];
	        this.affected = source["affected"];
	        this.executionMs = source["executionMs"];
	        this.success = source["success"];
	        this.message = source["message"];
	        this.truncatedColumns = source["truncatedColumns"];
	    }
	}
	export class RowUpdate {
	    keys: Record<string, any>;
	    values: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new RowUpdate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.keys = source["keys"];
	        this.values = source["values"];
	    }
	}
	export class TableDataPage {
	    columns: string[];
	    rows: any[];
	    totalRows: number;
	    hasNextPage: boolean;
	    page: number;
	    pageSize: number;
	    primaryKey: string;
	
	    static createFrom(source: any = {}) {
	        return new TableDataPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = source["columns"];
	        this.rows = source["rows"];
	        this.totalRows = source["totalRows"];
	        this.hasNextPage = source["hasNextPage"];
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.primaryKey = source["primaryKey"];
	    }
	}
	export class TableLookupFilter {
	    column: string;
	    operator: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new TableLookupFilter(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.column = source["column"];
	        this.operator = source["operator"];
	        this.value = source["value"];
	    }
	}

}

