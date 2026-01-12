const fs = require('fs');
const xml2js = require('xml2js');

// Read the metadata file
fs.readFile('federationmetadata.xml', 'utf8', (err, data) => {
  if (err) {
    console.error('Error reading metadata file:', err);
    return;
  }

  // Parse the XML
  const parser = new xml2js.Parser();
  parser.parseString(data, (err, result) => {
    if (err) {
      console.error('Error parsing XML:', err);
      return;
    }

    try {
      // Extract the certificate
      // The path may vary depending on the XML structure
      const cert = result.EntityDescriptor.IDPSSODescriptor[0].KeyDescriptor[0].KeyInfo[0].X509Data[0].X509Certificate[0];
      
      // Format the certificate with headers
      const formattedCert = [
        '-----BEGIN CERTIFICATE-----',
        cert,
        '-----END CERTIFICATE-----'
      ].join('\n');

      // Write to cert.pem
      fs.writeFile('cert.pem', formattedCert, (err) => {
        if (err) {
          console.error('Error writing certificate file:', err);
          return;
        }
        console.log('Certificate extracted and saved to cert.pem');
      });
    } catch (e) {
      console.error('Error extracting certificate:', e);
    }
  });
});
