"use strict";
const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const gcp = require('@pulumi/gcp');
const AWS = require('aws-sdk');
const awssns= require('@pulumi/aws/sns');
const config = new pulumi.Config();

const myTopic = new aws.sns.Topic("my-topic", {
    displayName: "My SNS Topic",
  });

const vpc = new aws.ec2.Vpc("custom", {
    cidrBlock: "172.16.0.0/16",

});

const ig = new aws.ec2.InternetGateway("igw", {
    vpcId: vpc.id,
});

const publicRouteTable = new aws.ec2.RouteTable("public-rt", {
    vpcId: vpc.id,
});

const privateRouteTable = new aws.ec2.RouteTable("private-rt", {
    vpcId: vpc.id,
});

const publicSubnets = [];
const privateSubnets = [];

for (let i = 1; i <= 3; i++) {
    
    const availabilityZonePrefix = config.require('region');
    
    const publicSubnet = new aws.ec2.Subnet(`public-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `172.16.${i}.0/24`,
        mapPublicIpOnLaunch: true,
        availabilityZone: `${availabilityZonePrefix}${["a", "b", "c"][i-1]}`,
    });

    const privateSubnet = new aws.ec2.Subnet(`private-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `172.16.${i+10}.0/24`,
        mapPublicIpOnLaunch: false,
        availabilityZone: `${availabilityZonePrefix}${["a", "b", "c"][i-1]}`,
    });

    publicSubnets.push(publicSubnet);
    privateSubnets.push(privateSubnet);
    
    new aws.ec2.RouteTableAssociation(`public-rta-${i}`, {
        subnetId: publicSubnet.id,
        routeTableId: publicRouteTable.id,
    });

    new aws.ec2.RouteTableAssociation(`private-rta-${i}`, {
        subnetId: privateSubnet.id,
        routeTableId: privateRouteTable.id,
    });
}

new aws.ec2.Route("public-route", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: "0.0.0.0/0",
    gatewayId: ig.id,
});

// Create an Application Security Group
const appSecurityGroup = new aws.ec2.SecurityGroup('appSecurityGroup', {
    vpcId: vpc.id,
    description: 'Application Security Group',
    ingress: [
        {
            protocol: 'tcp',
            fromPort: 22,
            toPort: 22,
            cidrBlocks: ['0.0.0.0/0'], // Allow SSH from anywhere
        },
    ],
    egress: [
        {
            protocol: '-1',
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ['0.0.0.0/0'], 
        },
    ]
});
// console.log(publicSubnets)
// console.log(this.publicSubnetsIds)

// Create a new DB parameter group
const dbParameterGroup = new aws.rds.ParameterGroup('csye-6225', {
    family: 'postgres15',
    description: 'Custom parameter group for my RDS instance',
    parameters: [
        {
            name: 'rds.force_ssl',
            value: '0',
        },
    ]
});

// Create a new security group for the RDS instance
const databaseSecurityGroup = new aws.ec2.SecurityGroup('databaseSecurityGroup', {
    description: 'Database security group for RDS',
    vpcId: vpc.id,
});

// Add an ingress rule to allow traffic from the application security group
const ingressRule = new aws.ec2.SecurityGroupRule('ingressRule', {
    type: 'ingress',
    fromPort: 5432, 
    toPort: 5432, 
    protocol: 'tcp',
    securityGroupId: databaseSecurityGroup.id,
    sourceSecurityGroupId: appSecurityGroup.id, 
});

const egressRuleEC2toRDS = new aws.ec2.SecurityGroupRule('egressRuleEC2ToRDS', {
    type: 'egress',
    fromPort: 5432, 
    toPort: 5432, 
    protocol: 'tcp',
    securityGroupId: appSecurityGroup.id,
    sourceSecurityGroupId: databaseSecurityGroup.id, 

});



// Create a new security group for the load balancer
const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup("loadBalancerSecurityGroup", {
    vpcId: vpc.id,
    description: 'Load Balancer Security Group',
    ingress: [
        // // Allow incoming TCP traffic on port 80
        // {
        //     protocol: "tcp",
        //     fromPort: 80,
        //     toPort: 80,
        //     cidrBlocks: ["0.0.0.0/0"],
        // },
        // Allow incoming TCP traffic on port 443
        {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
    egress: [
        // Allow incoming TCP traffic on port 8080
        {
            protocol: "tcp",
            fromPort: 8080,
            toPort: 8080,
            securityGroups: [appSecurityGroup.id],
        }, 
    ]
});


const loadBalancerRuleForAppSecurity = new aws.ec2.SecurityGroupRule('ingressRuleForAppSec', {
    type: 'ingress',
    fromPort: 8080, 
    toPort: 8080, 
    protocol: 'tcp',
    securityGroupId: appSecurityGroup.id,
    sourceSecurityGroupId: loadBalancerSecurityGroup.id, 
});

const dbsubnetgroup = new aws.rds.SubnetGroup("rdssubnetgroup", {
    subnetIds: privateSubnets,
})

const rdsInstance = new aws.rds.Instance('my-rds-instance', {
    allocatedStorage: 20,
    storageType: 'gp2',
    engine: 'postgres', 
    instanceClass: 'db.t3.micro', 
    name: config.require('name'),
    username:config.require('username'),
    password: config.require('password'), 
    skipFinalSnapshot: true, 
    multiAz: false, 
    dbSubnetGroupName: dbsubnetgroup, 
    publiclyAccessible: false, 
    vpcSecurityGroupIds: [databaseSecurityGroup.id],
    parameterGroupName: dbParameterGroup.name
});

function getSubnetIds(publicSubnets) {
    return publicSubnets[0].id;
}

const subnetid = getSubnetIds(publicSubnets);
const userDataScript = pulumi.interpolate`#!/bin/bash
 ENV_FILE=/opt/webapp/.env
  sudo touch $ENV_FILE
  echo 'DATABASE_USER=${rdsInstance.username}' >> $ENV_FILE
  echo 'DATABASE_PASSWORD=${rdsInstance.password}' >> $ENV_FILE
  echo 'DATABASE_NAME=${rdsInstance.name}' >> $ENV_FILE
  echo 'HOST=${rdsInstance.address}' >> $ENV_FILE
  echo 'DATABASE_PORT=5432' >> $ENV_FILE
  echo 'PORT=${config.require('appPort')}' >> $ENV_FILE
  echo 'TOPIC_ARN=${myTopic.arn}' >> $ENV_FILE
  echo 'AWS_REGION=${config.require('region')}' 
  sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/bin/cloudwatch-config.json \
  -s  
  `


const encodedUserDataScript = userDataScript.apply(s => Buffer.from(s).toString('base64'));
  // Define your IAM role for the EC2 instance
const role = new aws.iam.Role("ec2Role", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                Service: "ec2.amazonaws.com"
            },
            Action: "sts:AssumeRole",
        }],
    }),
});


// Attach the CloudWatchAgentServerPolicy to the IAM role
const policyAttachment = new aws.iam.RolePolicyAttachment("attachIAMRole", {
    role:role.id,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

const sns_publish_policy = new aws.iam.Policy("sns_publish_policy", {
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "sns:Publish",
                "sns:RemovePermission",
                "sns:SetTopicAttributes",
                "sns:DeleteTopic",
                "sns:ListSubscriptionsByTopic",
                "sns:GetTopicAttributes",
                "sns:Receive",
                "sns:AddPermission",
                "sns:Subscribe"
            ],
            Resource: "*"
        }]
    })
});
new aws.iam.RolePolicyAttachment("rolePolicyAttachment2", {
  role: role.id,
  policyArn: sns_publish_policy.arn,
});

let cloudAgentProfile = new aws.iam.InstanceProfile("cloudAgentProfile", {role: role.name});

// // Launch an EC2 Instance
// const instance = new aws.ec2.Instance('myInstance', {
//     ami: config.require('ami'), // Your custom AMI ID
//     instanceType: 't2.micro', // Specify the instance type you need
//     keyName: config.require('keyPair'), // Your SSH key pair name
//     securityGroups: [appSecurityGroup.id],
//     subnetId: subnetid , // Your subnet ID
//     rootBlockDevice: {
//         volumeSize: config.getNumber('rootVolumeSize', 25), // 25 GB root volume size
//         volumeType: config.get('rootVolumeType', 'gp2'), // General Purpose SSD (GP2)
//         deleteOnTermination: true,
//     },
//     iamInstanceProfile: cloudAgentProfile.name,
//     userData: userDataScript,
// });

// // an EC2 instance with 'publicIp' as its IP address.
// let record = new aws.route53.Record('route53', {
//     name: config.require('domain'),
//     type: 'A',
//     ttl: 60, // specify your desired ttl
//     records: [instance.publicIp], 
//     zoneId: config.require('hostedzone'), // replace 'your-zone-id' with your actual zone id
// });
let launchTemplate = new aws.ec2.LaunchTemplate("launchTemplate", {
    name:"ami_launch_template",
    blockDeviceMappings: [
        {
            
            deviceName: "/dev/xvda",
            ebs: {
                // Here we are creating a 20GB gp2 volume
                volumeSize: 8,
                volumeType: "gp3",
                // Optionally delete the EBS volume on instance termination
                deleteOnTermination: true,
            },
        },
    ],
    disableApiTermination: false,
    ebsOptimized: false,
    imageId: config.require('ami'),
    instanceType: "t2.micro",
    keyName: config.require('keyPair'),
    vpcSecurityGroupIds: [appSecurityGroup.id],
    iamInstanceProfile: {
        arn: cloudAgentProfile.arn,
    },
    // Put your actual user data here
    userData: encodedUserDataScript,
 });

 // Create an ALB Target Group
const targetGroup = new aws.lb.TargetGroup("targetGroup", {
    port: 8080,
    protocol: "HTTP",
    
    vpcId: vpc.id,  // replace with your VPC ID
    targetType: "instance",
    slowStart: 60,
    healthCheck: {
        enabled: true,
        path: "/healthz",
        interval: 20,
        timeout: 3,
        unhealthyThreshold: 2,
        healthyThreshold: 2,
    },
});

let publicsubnetIds = publicSubnets.map((publicsubnet) => {
    return publicsubnet.id;
})
// Create an Application Load Balancer
const applicationLoadBalancer = new aws.lb.LoadBalancer("applicationLoadBalancer", {
    subnets: publicsubnetIds,
    loadBalancerType: "application",
    securityGroups: [loadBalancerSecurityGroup.id]
});

// Add a listener to the application load balancer
const httpListener = new aws.lb.Listener("http-listener", {
    loadBalancerArn: applicationLoadBalancer.arn,
    port: 443,
    protocol: "HTTPS",
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
    certificateArn: config.require('certificateArn'),
});

// Create an autoscaling group.
let autoScalingGroup = new aws.autoscaling.Group("my-autoscaling-group", {
    desiredCapacity: 1, // Set to desire capacity.
    maxSize: 3, // Set to max size.
    minSize: 1, // Set to min size.
    defaultCooldown: 60,
    defaultInstanceWarmup: 60,
    name:"auto_scaling_group",
    launchTemplate: {
        id: launchTemplate.id,
        version: "$Latest",
    },
    tags: [{
        key: "instanceType",
        value: "webapp",
        propagateAtLaunch: true,
    }],
    healthCheckType: "EC2",
    targetGroupArns: [targetGroup.arn],
    vpcZoneIdentifiers: publicsubnetIds,  // Update this to your actual VPC Subnet IDs.
});

let scaleUpPolicy = new aws.autoscaling.Policy("scaleup", {
    adjustmentType: "ChangeInCapacity",
    autoscalingGroupName: autoScalingGroup.name,
    cooldown: 60,
    scalingAdjustment: 1,
});

let scaleDownPolicy = new aws.autoscaling.Policy("scaledown", {
    adjustmentType: "ChangeInCapacity",
    autoscalingGroupName: autoScalingGroup.name,
    cooldown: 30,
    scalingAdjustment: -1,
});

let cpuUtilizationHighAlarm = new aws.cloudwatch.MetricAlarm("cpuHigh", {
    alarmActions: [scaleUpPolicy.arn],
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: "2",
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: "60",
    statistic: "Average",
    threshold: "5",
    alarmDescription: "This metric triggers when CPU Utilization is above 5%",
    dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    },
});

let cpuUtilizationLowAlarm = new aws.cloudwatch.MetricAlarm("cpuLow", {
    alarmActions: [scaleDownPolicy.arn],
    comparisonOperator: "LessThanThreshold",
    evaluationPeriods: "2",
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: "60",
    statistic: "Average",
    threshold: "3",
    alarmDescription: "This metric triggers when CPU Utilization is below 3%",
        dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    },
});

const zoneId = aws.route53.getZone({name: config.require('domain')}, {async: true}).then(zone => zone.zoneId);

const record = new aws.route53.Record("alias", {
    name: config.require('domain'),
    type: "A",
    zoneId: zoneId,
    aliases: [
        {
            name: applicationLoadBalancer.dnsName,
            zoneId: applicationLoadBalancer.zoneId,
            evaluateTargetHealth: true
        }
    ]
});

const tableName = config.require('tableName');

// const params = {
//   TableName: tableName,
//   AttributeDefinitions: [
//     {
//       AttributeName: 'id',
//       AttributeType: 'S',
//     },
//   ],
//   KeySchema: [
//     {
//       AttributeName: 'id',
//       KeyType: 'HASH',
//     },
//   ],
//   BillingMode: 'PAY_PER_REQUEST',
//   Tags: [
//     {
//       Key: 'Name',
//       Value: 'EmailsDynamoDBTable',
//     },
//   ],
// };

// Create a DynamoDB table
const dynamoTable = new aws.dynamodb.Table(tableName, {
    attributes: [{
        name: "id",
        type: "S", // String type for the hash key
    }],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST", // You can change this to "PROVISIONED" if you want provisioned capacity
    tags: {
        Name: "MyDynamoDBTable", // Replace with your desired tags
    },
});


// Create a Google Cloud Storage bucket
const bucket = new gcp.storage.Bucket('my-bucket', {
    location: 'us-central1',
    forceDestroy: true,
});

// Create a GCP service account
let account = new gcp.serviceaccount.Account("account", {
    accountId: "my-service-account",
    displayName: "My Service Account",

});

// Create a service account key
let accountKey = new gcp.serviceaccount.Key("accountKey", {
    serviceAccountId: account.accountId,
});

const customRole = new gcp.projects.IAMCustomRole("myCustomRole", {
    roleId: "StorageObjectCreator",
    title: "Storage Object Creator",
    permissions: ["storage.objects.create"],
    project: config.require('project'),
  });

  const roleBinding = new gcp.projects.IAMMember("myRoleBinding", {
    role: customRole.name,
    member: pulumi.interpolate`serviceAccount:${account.email}`,
    project: config.require('project'),
  });


const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "lambda.amazonaws.com",
            },
        }],
    }),
  });

  new aws.iam.RolePolicyAttachment("basicexecutionrolepolicy", {
    role: lambdaRole.id,
    policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
  });


  new aws.iam.RolePolicyAttachment("dynamodbrolepolicy", {
    role: lambdaRole.id,
    policyArn: aws.iam.ManagedPolicies.AmazonDynamoDBFullAccess,
  });


// Define the lambda function
const lambdaFunction = new aws.lambda.Function('webapp-csye6225', {
    name:'webapp-sns-csye6225',
    role:lambdaRole.arn,
    runtime: "nodejs16.x",
    code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive('./serverless.zip'),
    }),
    handler: "index.handler",
    environment: {
        variables: {
            "GCP_SECRET_KEY": accountKey.privateKey,
            "BUCKET_NAME": bucket.name,
            "MAILGUN_API_KEY": config.require('mailgun_api_key'),
            "TABLE_NAME": dynamoTable.name,
        },
    },
    timeout: 600,
});

const topicSubs = new aws.sns.TopicSubscription("mySubscription", {
    topic: myTopic.arn,
    protocol: "lambda",
    endpoint: lambdaFunction.arn,
  });


  const lambdaFunctionPermission = new aws.lambda.Permission("lambdaPermission", {
    action: "lambda:InvokeFunction",
    function: lambdaFunction.name,
    principal: "sns.amazonaws.com",
    sourceArn: myTopic.arn,
  });

exports.databaseSecurityGroupId = databaseSecurityGroup.id;
exports.publicSubnetsIds = publicSubnets.map(ps => ps.id);
exports.privateSubnetsIds = privateSubnets.map(ps => ps.id);
exports.vpcId = vpc.id;
exports.loadBalancerSecurityGroupId = loadBalancerSecurityGroup.id;
exports.rdsInstanceId = rdsInstance.id;
// Export bucket name and service account key name
exports.bucketName = bucket.name;
exports.accountKeyName = accountKey.name;
exports.serviceAccountEmail = account.email;
exports.accountId = accountKey.id;
exports.privateKey = accountKey.privateKey;
//exports.instanceId = instance.id;