# iac-pulumi


Created Virtual Private Cloud (VPC) with 3 public subnets and 3 private subnets, each in a different availability zone in the same region in the same VPC. Each of the 3 availability zone must have one public and one private subnet.

Location being `us-east-1`

# Step to import SSL certificate into AWS
aws acm import-certificate --certificate fileb://your/dir/certificate-file --private-key fileb://your/dir/private-key-file --certificate-chain fileb://your/dir/certificate-chain-file --profile your_profile --region your_aws_region
