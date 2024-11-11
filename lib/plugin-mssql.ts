// =================================================================================
// File:    plugin-mssql.js
//
// Author:  Jarle Elshaug
//
// Purpose: SQL user-provisioning
//
// Prereq:
// TABLE [dbo].[User](
//  [UserID] [varchar](50) NOT NULL,
//  [Enabled] [varchar](50) NULL,
//  [Password] [varchar](50) NULL,
//  [FirstName] [varchar](50) NULL,
//  [MiddleName] [varchar](50) NULL,
//  [LastName] [varchar](50) NULL,
//  [Email] [varchar](50) NULL,
//  [MobilePhone] [varchar](50) NULL
// )
//
// Supported attributes:
//
// GlobalUser   Template                                Scim                        Endpoint
// --------------------------------------------------------------------------------------------
// User name    %AC%                                    userName                        UserID
// Suspended    (auto included)                         active                          Enabled
// Password     %P%                                     password                        Password
// First Name   %UF%                                    name.givenName                  FirstName
// Middle Name  %UMN%                                   name.middleName                 MiddleName
// Last Name    %UL%                                    name.familyName                 LastName
// Email        %UE% (Emails, type=Work)                emails.work                     emailAddress
// Phone        %UP% (Phone Numbers, type=Work)         phoneNumbers.work               phoneNumber
//
// =================================================================================

'use strict'

import { Connection, Request } from 'tedious'
// for supporting nodejs running scimgateway package directly, using dynamic import instead of: import { ScimGateway } from 'scimgateway'
// scimgateway also inclues HelperRest: import { ScimGateway, HelperRest } from 'scimgateway'

// start - mandatory plugin initialization
const ScimGateway: typeof import('scimgateway').ScimGateway = await (async () => {
  try {
    return (await import('scimgateway')).ScimGateway
  } catch (err) {
    const source = './scimgateway.ts'
    return (await import(source)).ScimGateway
  }
})()
const scimgateway = new ScimGateway()
const config = scimgateway.getConfig()
scimgateway.authPassThroughAllowed = false
// end - mandatory plugin initialization

if (config?.connection?.authentication?.options?.password) {
  config.connection.authentication.options.password = scimgateway.getSecret('endpoint.connection.authentication.options.password')
}

// =================================================
// getUsers
// =================================================
scimgateway.getUsers = async (baseEntity, getObj, attributes, ctx) => {
  const action = 'getUsers'
  scimgateway.logDebug(baseEntity, `handling "${action}" getObj=${getObj ? JSON.stringify(getObj) : ''} attributes=${attributes}`)

  let sqlQuery

  // mandatory if-else logic - start
  if (getObj.operator) {
    if (getObj.operator === 'eq' && ['id', 'userName', 'externalId'].includes(getObj.attribute)) {
      // mandatory - unique filtering - single unique user to be returned - correspond to getUser() in versions < 4.x.x
      sqlQuery = `select * from [User] where UserID = '${getObj.value}'`
    } else if (getObj.operator === 'eq' && getObj.attribute === 'group.value') {
      // optional - only used when groups are member of users, not default behavior - correspond to getGroupUsers() in versions < 4.x.x
      throw new Error(`${action} error: not supporting groups member of user filtering: ${getObj.rawFilter}`)
    } else {
      // optional - simpel filtering
      throw new Error(`${action} error: not supporting simpel filtering: ${getObj.rawFilter}`)
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
    throw new Error(`${action} not error: supporting advanced filtering: ${getObj.rawFilter}`)
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all users to be returned - correspond to exploreUsers() in versions < 4.x.x
    sqlQuery = 'select * from [User]'
  }
  // mandatory if-else logic - end

  if (!sqlQuery) throw new Error(`${action} error: mandatory if-else logic not fully implemented`)

  try {
    return await new Promise((resolve, reject) => {
      const ret: any = { // itemsPerPage will be set by scimgateway
        Resources: [],
        totalResults: null,
      }

      const connectionCfg: any = scimgateway.copyObj(config.connection)
      if (ctx?.request?.header?.authorization) { // Auth PassThrough (don't use configuration password)
        if (!connectionCfg.authentication) connectionCfg.authentication = {}
        if (!connectionCfg.authentication.type) connectionCfg.authentication.type = 'default'
        if (!connectionCfg.authentication.options) connectionCfg.authentication.options = {}
        const [username, password] = getCtxAuth(ctx)
        connectionCfg.authentication.options.password = password
        if (username) connectionCfg.authentication.options.userName = username
      }

      const connection = new Connection(connectionCfg)

      connection.on('connect', function (err) {
        if (err) {
          const e = new Error(`exploreUsers MSSQL client connect error: ${err.message}`)
          return reject(e)
        }
        const request = new Request(sqlQuery, function (err, rowCount, rows) {
          if (err) {
            connection.close()
            const e = new Error(`exploreUsers MSSQL client request: ${sqlQuery} Error: ${err.message}`)
            return reject(e)
          }

          for (const row in rows) {
            const scimUser = {
              id: rows[row].UserID.value ? rows[row].UserID.value : undefined,
              userName: rows[row].UserID.value ? rows[row].UserID.value : undefined,
              active: rows[row].Enabled.value === 'true' || false,
              name: {
                givenName: rows[row].FirstName.value ? rows[row].FirstName.value : undefined,
                middleName: rows[row].MiddleName.value ? rows[row].MiddleName.value : undefined,
                familyName: rows[row].LastName.value ? rows[row].LastName.value : undefined,
              },
              phoneNumbers: rows[row].MobilePhone.value ? [{ type: 'work', value: rows[row].MobilePhone.value }] : undefined,
              emails: rows[row].Email.value ? [{ type: 'work', value: rows[row].Email.value }] : undefined,
            }
            ret.Resources.push(scimUser)
          }
          connection.close()
          resolve(ret) // all explored users
        }) // request
        connection.execSql(request)
      }) // connection
      connection.connect() // initialize the connection
    }) // Promise
  } catch (err: any) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// createUser
// =================================================
scimgateway.createUser = async (baseEntity, userObj, ctx) => {
  const action = 'createUser'
  scimgateway.logDebug(baseEntity, `handling "${action}" userObj=${JSON.stringify(userObj)}`)

  try {
    return await new Promise((resolve, reject) => {
      if (!userObj.name) userObj.name = {}
      if (!userObj.emails) userObj.emails = { work: {} }
      if (!userObj.phoneNumbers) userObj.phoneNumbers = { work: {} }

      const insert = {
        UserID: `'${userObj.userName}'`,
        Enabled: (userObj.active) ? `'${userObj.active}'` : '\'false\'',
        Password: (userObj.password) ? `'${userObj.password}'` : null,
        FirstName: (userObj.name.givenName) ? `'${userObj.name.givenName}'` : null,
        MiddleName: (userObj.name.middleName) ? `'${userObj.name.middleName}'` : null,
        LastName: (userObj.name.familyName) ? `'${userObj.name.familyName}'` : null,
        MobilePhone: (userObj.phoneNumbers.work.value) ? `'${userObj.phoneNumbers.work.value}'` : null,
        Email: (userObj.emails.work.value) ? `'${userObj.emails.work.value}'` : null,
      }

      const connectionCfg: any = scimgateway.copyObj(config.connection)
      if (ctx?.request?.header?.authorization) { // Auth PassThrough (don't use configuration password)
        if (!connectionCfg.authentication) connectionCfg.authentication = {}
        if (!connectionCfg.authentication.type) connectionCfg.authentication.type = 'default'
        if (!connectionCfg.authentication.options) connectionCfg.authentication.options = {}
        const [username, password] = getCtxAuth(ctx)
        connectionCfg.authentication.options.password = password
        if (username) connectionCfg.authentication.options.userName = username
      }
      const connection = new Connection(connectionCfg)

      connection.on('connect', function (err) {
        if (err) {
          const e = new Error(`createUser MSSQL client connect error: ${err.message}`)
          return reject(e)
        }
        const sqlQuery = `insert into [User] (UserID, Enabled, Password, FirstName, MiddleName, LastName, Email, MobilePhone) 
                values (${insert.UserID}, ${insert.Enabled}, ${insert.Password}, ${insert.FirstName}, ${insert.MiddleName}, ${insert.LastName}, ${insert.Email}, ${insert.MobilePhone})`

        const request = new Request(sqlQuery, function (err) {
          if (err) {
            connection.close()
            const e = new Error(`createUser MSSQL client request: ${sqlQuery} error: ${err.message}`)
            return reject(e)
          }
          connection.close()
          resolve(null)
        }) // request
        connection.execSql(request)
      }) // connection
      connection.connect() // initialize the connection
    }) // Promise
  } catch (err: any) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// deleteUser
// =================================================
scimgateway.deleteUser = async (baseEntity, id, ctx) => {
  const action = 'deleteUser'
  scimgateway.logDebug(baseEntity, `handling "${action}" id=${id}`)

  try {
    return await new Promise((resolve, reject) => {
      const connectionCfg: any = scimgateway.copyObj(config.connection)
      if (ctx?.request?.header?.authorization) { // Auth PassThrough (don't use configuration password)
        if (!connectionCfg.authentication) connectionCfg.authentication = {}
        if (!connectionCfg.authentication.type) connectionCfg.authentication.type = 'default'
        if (!connectionCfg.authentication.options) connectionCfg.authentication.options = {}
        const [username, password] = getCtxAuth(ctx)
        connectionCfg.authentication.options.password = password
        if (username) connectionCfg.authentication.options.userName = username
      }
      const connection = new Connection(connectionCfg)

      connection.on('connect', function (err) {
        if (err) {
          const e = new Error(`deleteUser MSSQL client connect error: ${err.message}`)
          return reject(e)
        }
        const sqlQuery = `delete from [User] where UserID = '${id}'`
        const request = new Request(sqlQuery, function (err) {
          if (err) {
            connection.close()
            const e = new Error(`deleteUser MSSQL client request: ${sqlQuery} error: ${err.message}`)
            return reject(e)
          }
          connection.close()
          resolve(null)
        }) // request
        connection.execSql(request)
      }) // connection
      connection.connect() // initialize the connection
    }) // Promise
  } catch (err: any) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// modifyUser
// =================================================
scimgateway.modifyUser = async (baseEntity, id, attrObj, ctx) => {
  const action = 'modifyUser'
  scimgateway.logDebug(baseEntity, `handling "${action}" id=${id} attrObj=${JSON.stringify(attrObj)}`)

  try {
    return await new Promise((resolve, reject) => {
      if (!attrObj.name) attrObj.name = {}
      if (!attrObj.emails) attrObj.emails = { work: {} }
      if (!attrObj.phoneNumbers) attrObj.phoneNumbers = { work: {} }

      let sql = ''

      if (attrObj.active !== undefined) sql += `Enabled='${attrObj.active}',`
      if (attrObj.password !== undefined) {
        if (attrObj.password === '') sql += 'Password=null,'
        else sql += `Password='${attrObj.password}',`
      }
      if (attrObj.name.givenName !== undefined) {
        if (attrObj.name.givenName === '') sql += 'FirstName=null,'
        else sql += `FirstName='${attrObj.name.givenName}',`
      }
      if (attrObj.name.middleName !== undefined) {
        if (attrObj.name.middleName === '') sql += 'MiddleName=null,'
        else sql += `MiddleName='${attrObj.name.middleName}',`
      }
      if (attrObj.name.familyName !== undefined) {
        if (attrObj.name.familyName === '') sql += 'LastName=null,'
        else sql += `LastName='${attrObj.name.familyName}',`
      }
      if (attrObj.phoneNumbers.work.value !== undefined) {
        if (attrObj.phoneNumbers.work.value === '') sql += 'MobilePhone=null,'
        else sql += `MobilePhone='${attrObj.phoneNumbers.work.value}',`
      }
      if (attrObj.emails.work.value !== undefined) {
        if (attrObj.emails.work.value === '') sql += 'Email=null,'
        else sql += `Email='${attrObj.emails.work.value}',`
      }

      sql = sql.substr(0, sql.length - 1) // remove trailing ","

      const connectionCfg: any = scimgateway.copyObj(config.connection)
      if (ctx?.request?.header?.authorization) { // Auth PassThrough (don't use configuration password)
        if (!connectionCfg.authentication) connectionCfg.authentication = {}
        if (!connectionCfg.authentication.type) connectionCfg.authentication.type = 'default'
        if (!connectionCfg.authentication.options) connectionCfg.authentication.options = {}
        const [username, password] = getCtxAuth(ctx)
        connectionCfg.authentication.options.password = password
        if (username) connectionCfg.authentication.options.userName = username
      }
      const connection = new Connection(connectionCfg)

      connection.on('connect', function (err) {
        if (err) {
          const e = new Error(`modifyUser MSSQL client connect error: ${err.message}`)
          return reject(e)
        }
        const sqlQuery = `update [User] set ${sql} where UserID like '${id}'`
        const request = new Request(sqlQuery, function (err) {
          if (err) {
            connection.close()
            const e = new Error(`modifyUser MSSQL client request: ${sqlQuery} error: ${err.message}`)
            return reject(e)
          }
          connection.close()
          resolve(null)
        }) // request
        connection.execSql(request)
      }) // connection
      connection.connect() // initialize the connection
    }) // Promise
  } catch (err: any) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// getGroups
// =================================================
scimgateway.getGroups = async (baseEntity, getObj, attributes) => {
  const action = 'getGroups'
  scimgateway.logDebug(baseEntity, `handling "${action}" getObj=${getObj ? JSON.stringify(getObj) : ''} attributes=${attributes}`)

  // mandatory if-else logic - start
  if (getObj.operator) {
    if (getObj.operator === 'eq' && ['id', 'displayName', 'externalId'].includes(getObj.attribute)) {
      // mandatory - unique filtering - single unique user to be returned - correspond to getUser() in versions < 4.x.x
    } else if (getObj.operator === 'eq' && getObj.attribute === 'members.value') {
      // mandatory - return all groups the user 'id' (getObj.value) is member of - correspond to getGroupMembers() in versions < 4.x.x
      // Resources = [{ id: <id-group>> , displayName: <displayName-group>, members [{value: <id-user>}] }]
    } else {
      // optional - simpel filtering
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all groups to be returned - correspond to exploreGroups() in versions < 4.x.x
  }
  // mandatory if-else logic - end

  return { Resources: [] } // groups not supported - returning empty Resources
}

// =================================================
// createGroup
// =================================================
scimgateway.createGroup = async (baseEntity, groupObj) => {
  const action = 'createGroup'
  scimgateway.logDebug(baseEntity, `handling "${action}" groupObj=${JSON.stringify(groupObj)}`)
  throw new Error(`${action} error: ${action} is not supported`)
}

// =================================================
// deleteGroup
// =================================================
scimgateway.deleteGroup = async (baseEntity, id) => {
  const action = 'deleteGroup'
  scimgateway.logDebug(baseEntity, `handling "${action}" id=${id}`)
  throw new Error(`${action} error: ${action} is not supported`)
}

// =================================================
// modifyGroup
// =================================================
scimgateway.modifyGroup = async (baseEntity, id, attrObj) => {
  const action = 'modifyGroup'
  scimgateway.logDebug(baseEntity, `handling "${action}" id=${id} attrObj=${JSON.stringify(attrObj)}`)
  throw new Error(`${action} error: ${action} is not supported`)
}

// =================================================
// helpers
// =================================================

//
// getCtxAuth returns username/secret from ctx header when using Auth PassThrough
//
const getCtxAuth = (ctx: undefined | Record<string, any>) => {
  if (!ctx?.request?.header?.authorization) return []
  const [authType, authToken] = (ctx.request.header.authorization || '').split(' ') // [0] = 'Basic' or 'Bearer'
  let username, password
  if (authType === 'Basic') [username, password] = (Buffer.from(authToken, 'base64').toString() || '').split(':')
  if (username) return [username, password] // basic auth
  else return [undefined, authToken] // bearer auth
}

//
// Cleanup on exit
//
process.on('SIGTERM', () => { // kill
})
process.on('SIGINT', () => { // Ctrl+C
})