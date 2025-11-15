// fetch-metadata.js - updated version
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;

async function fetchMetadata(url) {
  console.log(`Fetching federation metadata from: ${url}`);
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error('Error fetching federation metadata:', error.message);
    throw error;
  }
}

async function parseMetadataXml(xmlData) {
  try {
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(xmlData);
    return result;
  } catch (error) {
    console.error('Error parsing XML:', error.message);
    throw error;
  }
}

async function extractCertificate(parsedXml) {
  try {
    // The structure might be different with explicitArray: false
    const cert = parsedXml.EntityDescriptor.IDPSSODescriptor.KeyDescriptor.KeyInfo.X509Data.X509Certificate;
    
    // Format the certificate
    const formattedCert = [
      '-----BEGIN CERTIFICATE-----',
      cert,
      '-----END CERTIFICATE-----'
    ].join('\n');
    
    return formattedCert;
  } catch (error) {
    // If the path is different (e.g., there are multiple key descriptors)
    try {
      // Try alternative path for multiple key descriptors
      const cert = parsedXml.EntityDescriptor.IDPSSODescriptor.KeyDescriptor[0].KeyInfo.X509Data.X509Certificate;
      
      const formattedCert = [
        '-----BEGIN CERTIFICATE-----',
        cert,
        '-----END CERTIFICATE-----'
      ].join('\n');
      
      return formattedCert;
    } catch (nestedError) {
      console.error('Error extracting certificate:', error);
      console.error('Alternative extraction also failed:', nestedError);
      throw new Error('Failed to extract certificate from metadata');
    }
  }
}

async function extractSamlData(parsedXml) {
  try {
    const entityDescriptor = parsedXml.EntityDescriptor;
    const idpDescriptor = entityDescriptor.IDPSSODescriptor;
    
    // Get the entity ID (issuer)
    const entityID = entityDescriptor.$.entityID;
    
    // Get the single sign-on service endpoint with HTTP-POST binding
    let ssoPostEndpoint;
    
    if (Array.isArray(idpDescriptor.SingleSignOnService)) {
      ssoPostEndpoint = idpDescriptor.SingleSignOnService.find(
        service => service.$.Binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
      );
    } else {
      // If there's only one endpoint
      ssoPostEndpoint = idpDescriptor.SingleSignOnService.$.Binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' 
        ? idpDescriptor.SingleSignOnService 
        : null;
    }
    
    // Get the logout service endpoint if it exists
    let sloEndpoint = null;
    if (idpDescriptor.SingleLogoutService) {
      if (Array.isArray(idpDescriptor.SingleLogoutService)) {
        sloEndpoint = idpDescriptor.SingleLogoutService.find(
          service => service.$.Binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
        );
      } else {
        sloEndpoint = idpDescriptor.SingleLogoutService.$.Binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
          ? idpDescriptor.SingleLogoutService
          : null;
      }
    }
    
    return {
      entityID,
      entryPoint: ssoPostEndpoint ? ssoPostEndpoint.$.Location : null,
      logoutUrl: sloEndpoint ? sloEndpoint.$.Location : null
    };
  } catch (error) {
    console.error('Error extracting SAML endpoints:', error);
    throw new Error('Failed to extract SAML endpoints from metadata');
  }
}

async function fetchAndProcessMetadata(metadataUrl) {
  try {
    const xmlData = await fetchMetadata(metadataUrl);
    const parsedXml = await parseMetadataXml(xmlData);
    
    // Log the structure to help debug
    console.log('Parsed XML structure for debugging:');
    console.log(JSON.stringify(parsedXml.EntityDescriptor.IDPSSODescriptor, null, 2).substring(0, 500) + '...');
    
    const certificate = await extractCertificate(parsedXml);
    const endpoints = await extractSamlData(parsedXml);
    
    // Optionally save the certificate to a file
    await fs.writeFile('cert.pem', certificate);
    
    return {
      certificate,
      ...endpoints
    };
  } catch (error) {
    console.error('Failed to process federation metadata:', error);
    throw error;
  }
}

module.exports = { fetchAndProcessMetadata };